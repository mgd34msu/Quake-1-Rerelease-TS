/*
Not a ported C file -- vanilla WinQuake and this port's own seed
(quake-1-ts) predate SDL_GameController entirely; the re-release's own
engine (KEX) is closed. This module is a clean-room, game-agnostic home for
the two pieces of the SDL_GameController layer that need no K_* keynum, no
FFI handle and no engine state: parsing `gamecontrollerdb.txt`'s mapping-string
format, and the deadzone/easing axis math src/platform/sdl.ts's IN_JoyMove
applies to the two analog sticks. Per src/lib's own rule (ARCHITECTURE.md
"Source layout"), this file imports nothing from src/ outside src/lib.

=============================================================================
MAPPING-STRING PARSING

The 2021 re-release ships `gamecontrollerdb.txt` (the public
https://github.com/gabomdq/SDL_GameControllerDB database, "2.0.9 format" per
its own header comment) inside QuakeEX.kpf, at the VFS root. Its grammar
(SDL_gamecontroller.h's own doc comment for SDL_GameControllerAddMapping):

  one mapping per line:  GUID,name,field:value,field:value,...,
  '#' at line start:     a comment, ignored
  a blank line:          ignored
  the GUID:               32 lowercase hex digits (SDL_JoystickGUID as text)

SDL_GameControllerAddMappingsFromFile takes a real filesystem path, which
this port's VFS (zip-mounted kpf, PAK-mounted classic paks) does not
generally have -- src/platform/sdl.ts loads the file's bytes through
COM_LoadFile instead and hands the text here; ParseGameControllerDbMappings
splits it into individual mapping lines and hands each one to
SDL_GameControllerAddMapping (one call per line -- the per-line API, not the
per-file one), skipping comments/blanks and rejecting a line whose GUID
field is not well-formed rather than passing malformed text into the FFI
call.

=============================================================================
AXIS MATH

IN_ApplyDeadzone/IN_ApplyEasing/IN_AxisMagnitude below are ported from
Ironwail's Quake/in_sdl.c (GPLv2, this repo's own ARCHITECTURE.md reference
list) verbatim -- see in_sdl.c's own header comments on IN_ApplyDeadzone
("adapted from https://github.com/jeremiah-sypult/Quakespasm-Rift and
http://www.third-helix.com/2013/04/12/doing-thumbstick-dead-zones-right.html")
and IN_ApplyEasing. Both assume a stick already normalized to +-1 per axis
(SDL_ControllerAxisEvent.value / 32768, not 32767 -- Ironwail's own
IN_Commands divisor) and apply a CIRCULAR (vector-magnitude) deadzone and
outer threshold, not an independent per-axis one: the two components are
rescaled together so the resulting vector's direction is preserved, which is
what keeps a diagonal push from feeling weaker than a cardinal one on a
non-perfectly-circular stick (Ironwail's own comment: "my 360 controller is
slightly non-circular").
*/

export interface AxisValueT {
  x: number;
  y: number;
}

/*
GUID: 32 lowercase-or-uppercase hex digits (SDL_JoystickGUID printed as
text). A mapping line's first comma-separated field.
*/
const GUID_RE = /^[0-9a-fA-F]{32}$/;

/*
ParseGameControllerDbMappings -- split gamecontrollerdb.txt's full text into
individual, ready-to-add mapping-string lines. Comment lines ('#' as the
first non-whitespace character), blank lines, and lines whose GUID field
does not match the expected 32-hex-digit shape are dropped; every other line
is trimmed of its trailing CR (the file ships CRLF line endings) and
returned as-is, since SDL_GameControllerAddMapping wants the whole line
(GUID, name AND the field:value tail) as one string.
*/
export function ParseGameControllerDbMappings(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("#")) continue;
    const comma = trimmed.indexOf(",");
    const guid = comma < 0 ? trimmed : trimmed.slice(0, comma);
    if (!GUID_RE.test(guid)) continue;
    out.push(trimmed);
  }
  return out;
}

/*
================
IN_AxisMagnitude

Returns the vector length of the given joystick axis
================
*/
export function IN_AxisMagnitude(axis: AxisValueT): number {
  return Math.sqrt(axis.x * axis.x + axis.y * axis.y);
}

/*
================
IN_ApplyEasing

assumes axis values are in [-1, 1] and the vector magnitude has been clamped
at 1. Raises the axis values to the given exponent, keeping signs.
================
*/
export function IN_ApplyEasing(axis: AxisValueT, exponent: number): AxisValueT {
  const magnitude = IN_AxisMagnitude(axis);
  if (magnitude === 0) return { x: 0, y: 0 };

  const easedMagnitude = Math.pow(magnitude, exponent);
  return { x: axis.x * (easedMagnitude / magnitude), y: axis.y * (easedMagnitude / magnitude) };
}

/*
================
IN_ApplyDeadzone

in: raw joystick axis values converted to floats in +-1
out: applies a circular inner deadzone and a circular outer threshold and
clamps the magnitude at 1 (my 360 controller is slightly non-circular and
the stick travels further on the diagonals)

deadzone is expected to satisfy 0 < deadzone < 1 - outer_threshold
outer_threshold is expected to satisfy 0 < outer_threshold < 1 - deadzone
================
*/
export function IN_ApplyDeadzone(axis: AxisValueT, deadzone: number, outerThreshold: number): AxisValueT {
  const magnitude = IN_AxisMagnitude(axis);
  if (magnitude <= deadzone) return { x: 0, y: 0 };

  const newMagnitude = Math.min(1.0, (magnitude - deadzone) / (1.0 - deadzone - outerThreshold));
  const scale = newMagnitude / magnitude;
  return { x: axis.x * scale, y: axis.y * scale };
}
