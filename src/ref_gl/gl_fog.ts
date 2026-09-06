/*
Copyright (C) 2002-2009 John Fitzgibbons and others
Copyright (C) 2010-2014 QuakeSpasm developers
Ported from QuakeSpasm/FitzQuake's Quake/gl_fog.c (GNU GPL v2 or later).
Reference: /home/buzzkill/Projects/qsrc/quakespasm/Quake/gl_fog.c.

gl_fog.c has no WinQuake original: FitzQuake added global GL_EXP2 fog and
QuakeSpasm carried it forward; this port adds it as U21's documented
quality-of-life addition (PORTING.md's fidelity razor: the 2021 re-release's
maps ship worldspawn "fog" keys and an SVC_FOG network message, so matching
the KEX engine's observable behavior on that content means having fog at
all). Only the GLOBAL fog half of gl_fog.c is ported: the reference's
"VOLUMETRIC FOG" section (`r_vfog`, `Fog_DrawVFog`, `Fog_MarkModels`) is
QuakeSpasm's own stub-only feature -- both bodies are empty in the reference
and its `r_vfog` Cvar_RegisterVariable call is itself commented out there --
so none of it is ported; there is nothing to observe.

Deviations from the reference:
- `fog_density`/`fog_red`/... and their `old_*` counterparts are `static
  float`s private to gl_fog.c and read by no other translation unit
  (Fog_GetColor/Fog_GetDensity are the only cross-file readers, and both are
  exported functions here too), so they stay plain module-level `let`s per
  PORTING.md's globals rule (compare gl_warp.ts's `warpface`).
- `Fog_Update`/`Fog_GetColor`/`Fog_GetDensity` read `cl.time` directly (this
  unit's SCOPE restricts which files it may WRITE, not which it may import;
  gl_rmisc.ts and gl_rmain.ts already import `cl` from src/client/client.ts
  the same way), rather than threading the client clock through every call
  site as an extra parameter -- there is no existing convention for that in
  this renderer and PORTING.md rule 3 says not to improvise one.
- `Fog_ParseServerMessage` takes the raw wire fields as parameters instead of
  calling MSG_ReadByte/MSG_ReadShort itself: cl_parse.ts (out of this unit's
  SCOPE) owns every MSG_Read call and, per the unit brief, is wired by the
  coordinator to call this seam method with the bytes/short it already read
  off svc_fog. The normalization (`/255.0`, `/100.0`, the `time < 0` clamp)
  still happens here, unchanged from the reference body.
- `Fog_ParseWorldspawn` takes the worldspawn entity string as a parameter
  (`cl.worldmodel.entities` in the reference) rather than reaching into
  `cl.worldmodel` itself, since the caller (R_NewMap, gl_rmisc.ts) already
  has it and a null worldmodel would otherwise need a guard this function
  has no other reason to carry.
- The reference's `sscanf(value, "%f %f %f %f", ...)` partial-match semantics
  (each `%f` that fails to convert leaves its target at whatever
  Fog_ParseWorldspawn just set it to, i.e. the DEFAULT_DENSITY/DEFAULT_GRAY
  reset) are replicated with a whitespace split and a positional
  Number.parseFloat, stopping at the first non-numeric token exactly as
  sscanf would.
- `Fog_StartAdditive`/`Fog_StopAdditive` (the particle-drawing fog color pin)
  are not ported: no ported .ts file in this unit's SCOPE calls them
  (r_part.ts's particle drawing is out of SCOPE), so there is no call site to
  wire them into. Follow-up, not a silent drop.
- U44: Fog_Init no longer calls `Cmd_AddCommand("fog", ...)`. WinQuake links
  one renderer; this port compiles both in, and having both this file and
  src/ref_soft/r_fog.ts register the same command name from their own R_Init
  broke whichever renderer's test suite ran second in a shared `bun test`
  process (r_fog.ts's own header documents the empirical finding). The 'fog'
  command is now registered exactly once, at module load, by
  src/client/fog_cmd.ts, which dispatches through the active renderer's
  `Renderer.fogCommand` seam member (src/ref_gl/ref_gl.ts's `fogCommand` is
  the thin passthrough to Fog_FogCommand_f below). Fog_FogCommand_f itself is
  unchanged and still directly callable.
*/

import { type Vec3, vec3 } from "../common/mathlib";
import { type ParseState, COM_Parse, Q_atof } from "../common/common";
import { cl } from "../client/client";
import { Cmd_Argc, Cmd_Argv } from "../common/cmd";
import { Con_Printf } from "../client/console";
import { GL_EXP2, GL_FOG, GL_FOG_COLOR, GL_FOG_DENSITY, GL_FOG_MODE, qgl } from "./qgl";

const DEFAULT_DENSITY = 0.0;
const DEFAULT_GRAY = 0.3;

let fog_density = DEFAULT_DENSITY;
let fog_red = DEFAULT_GRAY;
let fog_green = DEFAULT_GRAY;
let fog_blue = DEFAULT_GRAY;

let old_density = DEFAULT_DENSITY;
let old_red = DEFAULT_GRAY;
let old_green = DEFAULT_GRAY;
let old_blue = DEFAULT_GRAY;

let fade_time = 0; // duration of fade
let fade_done = 0; // time when fade will be done

/*
=============
Fog_Update

update internal variables
=============
*/
export function Fog_Update(density: number, red: number, green: number, blue: number, time: number): void {
  // save previous settings for fade
  if (time > 0) {
    // check for a fade in progress
    if (fade_done > cl.time) {
      const f = (fade_done - cl.time) / fade_time;
      old_density = f * old_density + (1.0 - f) * fog_density;
      old_red = f * old_red + (1.0 - f) * fog_red;
      old_green = f * old_green + (1.0 - f) * fog_green;
      old_blue = f * old_blue + (1.0 - f) * fog_blue;
    } else {
      old_density = fog_density;
      old_red = fog_red;
      old_green = fog_green;
      old_blue = fog_blue;
    }
  }

  fog_density = density;
  fog_red = red;
  fog_green = green;
  fog_blue = blue;
  fade_time = time;
  fade_done = cl.time + time;
}

/*
=============
Fog_ParseServerMessage

handle an SVC_FOG message from the server. See this file's header: the raw
wire fields are read by cl_parse.ts and handed in here already off the wire
(density/red/green/blue the 0-255 bytes FitzQuake's svc_fog puts on the
wire, wireTime the raw signed short in centiseconds).
=============
*/
export function Fog_ParseServerMessage(density: number, red: number, green: number, blue: number, wireTime: number): void {
  const d = density / 255.0;
  const r = red / 255.0;
  const g = green / 255.0;
  const b = blue / 255.0;
  let time = wireTime / 100.0;
  if (time < 0.0) time = 0.0;

  Fog_Update(d, r, g, b, time);
}

/*
=============
Fog_FogCommand_f

handle the 'fog' console command
=============
*/
export function Fog_FogCommand_f(): void {
  let d: number;
  let r: number;
  let g: number;
  let b: number;
  let t: number;

  switch (Cmd_Argc()) {
    default:
    case 1:
      Con_Printf("usage:\n");
      Con_Printf("   fog <density>\n");
      Con_Printf("   fog <red> <green> <blue>\n");
      Con_Printf("   fog <density> <red> <green> <blue>\n");
      Con_Printf("current values:\n");
      Con_Printf('   "density" is "%f"\n', fog_density);
      Con_Printf('   "red" is "%f"\n', fog_red);
      Con_Printf('   "green" is "%f"\n', fog_green);
      Con_Printf('   "blue" is "%f"\n', fog_blue);
      return;
    case 2:
      d = Q_atof(Cmd_Argv(1));
      t = 0.0;
      r = fog_red;
      g = fog_green;
      b = fog_blue;
      break;
    case 3: // TEST
      d = Q_atof(Cmd_Argv(1));
      t = Q_atof(Cmd_Argv(2));
      r = fog_red;
      g = fog_green;
      b = fog_blue;
      break;
    case 4:
      d = fog_density;
      t = 0.0;
      r = Q_atof(Cmd_Argv(1));
      g = Q_atof(Cmd_Argv(2));
      b = Q_atof(Cmd_Argv(3));
      break;
    case 5:
      d = Q_atof(Cmd_Argv(1));
      r = Q_atof(Cmd_Argv(2));
      g = Q_atof(Cmd_Argv(3));
      b = Q_atof(Cmd_Argv(4));
      t = 0.0;
      break;
    case 6: // TEST
      d = Q_atof(Cmd_Argv(1));
      r = Q_atof(Cmd_Argv(2));
      g = Q_atof(Cmd_Argv(3));
      b = Q_atof(Cmd_Argv(4));
      t = Q_atof(Cmd_Argv(5));
      break;
  }

  if (d < 0.0) d = 0.0;
  if (r < 0.0) r = 0.0;
  else if (r > 1.0) r = 1.0;
  if (g < 0.0) g = 0.0;
  else if (g > 1.0) g = 1.0;
  if (b < 0.0) b = 0.0;
  else if (b > 1.0) b = 1.0;
  Fog_Update(d, r, g, b, t);
}

// sscanf(value, "%f %f %f %f", &fog_density, &fog_red, &fog_green,
// &fog_blue)'s partial-match semantics: each `%f` that fails to convert (or
// runs out of tokens) leaves its target untouched. `targets` already holds
// the post-reset defaults, so this only overwrites the prefix of `targets`
// that actually parses as a number.
function sscanf4f(value: string, targets: [number, number, number, number]): [number, number, number, number] {
  const tokens = value.trim().length === 0 ? [] : value.trim().split(/\s+/);
  const out: [number, number, number, number] = [...targets];
  for (let i = 0; i < 4 && i < tokens.length; i++) {
    const n = Number.parseFloat(tokens[i]);
    if (Number.isNaN(n)) break;
    out[i] = n;
  }
  return out;
}

/*
=============
Fog_ParseWorldspawn

called at map load. `entities` is cl.worldmodel.entities (the reference
reads it directly off cl.worldmodel; see this file's header).
=============
*/
export function Fog_ParseWorldspawn(entities: string): void {
  // initially no fog
  fog_density = DEFAULT_DENSITY;
  fog_red = DEFAULT_GRAY;
  fog_green = DEFAULT_GRAY;
  fog_blue = DEFAULT_GRAY;

  old_density = DEFAULT_DENSITY;
  old_red = DEFAULT_GRAY;
  old_green = DEFAULT_GRAY;
  old_blue = DEFAULT_GRAY;

  fade_time = 0.0;
  fade_done = 0.0;

  const ps: ParseState = { data: entities, index: 0 };
  let token = COM_Parse(ps);
  if (token === null) return; // error
  if (token[0] !== "{") return; // error

  for (;;) {
    token = COM_Parse(ps);
    if (token === null) return; // error
    if (token[0] === "}") break; // end of worldspawn

    const key = token[0] === "_" ? token.slice(1) : token;
    const trimmedKey = key.replace(/ +$/, "");

    const value = COM_Parse(ps);
    if (value === null) return; // error

    if (trimmedKey === "fog") {
      const [d, r, g, b] = sscanf4f(value, [fog_density, fog_red, fog_green, fog_blue]);
      fog_density = d;
      fog_red = r;
      fog_green = g;
      fog_blue = b;
    }
  }
}

/*
=============
Fog_GetColor

calculates fog color for this frame, taking into account fade times
=============
*/
export function Fog_GetColor(): Vec3 {
  const c = vec3();

  if (fade_done > cl.time) {
    const f = (fade_done - cl.time) / fade_time;
    c[0] = f * old_red + (1.0 - f) * fog_red;
    c[1] = f * old_green + (1.0 - f) * fog_green;
    c[2] = f * old_blue + (1.0 - f) * fog_blue;
  } else {
    c[0] = fog_red;
    c[1] = fog_green;
    c[2] = fog_blue;
  }

  for (let i = 0; i < 3; i++) c[i] = c[i] < 0 ? 0 : c[i] > 1 ? 1 : c[i];

  // find closest 24-bit RGB value, so solid-colored sky can match the fog
  // perfectly
  for (let i = 0; i < 3; i++) c[i] = Math.round(c[i] * 255) / 255.0;

  return c;
}

/*
=============
Fog_GetDensity

returns current density of fog
=============
*/
export function Fog_GetDensity(): number {
  if (fade_done > cl.time) {
    const f = (fade_done - cl.time) / fade_time;
    return f * old_density + (1.0 - f) * fog_density;
  }
  return fog_density;
}

/*
=============
Fog_SetupFrame

called at the beginning of each frame
=============
*/
export function Fog_SetupFrame(): void {
  const gl = qgl();
  gl.qglFogfv(GL_FOG_COLOR, Fog_GetColor());
  gl.qglFogf(GL_FOG_DENSITY, Fog_GetDensity() / 64.0);
}

/*
=============
Fog_EnableGFog

called before drawing stuff that should be fogged
=============
*/
export function Fog_EnableGFog(): void {
  if (Fog_GetDensity() > 0) qgl().qglEnable(GL_FOG);
}

/*
=============
Fog_DisableGFog

called after drawing stuff that should be fogged
=============
*/
export function Fog_DisableGFog(): void {
  if (Fog_GetDensity() > 0) qgl().qglDisable(GL_FOG);
}

/*
=============
Fog_SetupState

ericw -- moved from Fog_Init, state that needs to be setup when a new GL
context is created. Called from gl_rmisc.ts's R_Init (GL_EXP2 has no
per-map or per-frame reason to change).
=============
*/
export function Fog_SetupState(): void {
  qgl().qglFogi(GL_FOG_MODE, GL_EXP2);
}

/*
=============
Fog_Init

called when quake initializes. Called from gl_rmisc.ts's R_Init. Does NOT
register a 'fog' console command -- see this file's header (U44): that is
now src/client/fog_cmd.ts's job, dispatched through the Renderer seam.
=============
*/
export function Fog_Init(): void {
  Fog_SetupState();
}
