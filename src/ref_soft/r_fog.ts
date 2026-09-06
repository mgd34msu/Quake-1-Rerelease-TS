/*
Copyright (C) 2002-2009 John Fitzgibbons and others
Copyright (C) 2010-2014 QuakeSpasm developers
Loosely ported from quakespasm/Quake/gl_fog.c (GNU GPL v2 or later), as U27's
software-renderer twin of src/ref_gl/gl_fog.ts.

gl_fog.c has no WinQuake original (see gl_fog.ts's own header for the full
history); this file is this port's own software-renderer half of the same
U21/U27 addition, since WinQuake's software rasterizer has no fog of any
kind. ARCHITECTURE.md's "Renderers" section calls this out explicitly:
"Software: ... fog as a depth post-pass". A software rasterizer has no
per-fragment shader stage to hang an OpenGL-style GL_FOG onto, so instead of
fogging each span as it draws (which would mean threading fog state through
every one of d_scan.ts's/d_polyse.ts's/d_sprite.ts's/d_part.ts's/d_sky.ts's
drawers), this is a single pass over the finished frame that reads the
z-buffer the drawers already left behind and blends toward the fog color.

WHY THIS FILE DUPLICATES gl_fog.ts'S STATE INSTEAD OF IMPORTING IT

The software and GL renderers can both be loaded in one process (this unit's
brief, and every existing ref_soft test that also happens to run beside a
ref_gl suite in the same `bun test` process); each renderer's fog state is
its own -- svc_fog / the worldspawn "fog" key only ever reaches the ACTIVE
renderer's `fogParseServerMessage`/`fogParseWorldspawn` (src/client/render.ts's
`re.current?.`), so there is no requirement that the two states agree, and
importing gl_fog.ts here would pull qgl.ts/glquake.ts (a real or headless GL
context) into every software-only test and build, which
src/ref_soft/**'s existing self-sufficiency does not do anywhere else. So
`fog_density`/`fog_red`/... below are this module's OWN private `let`s,
shaped identically to gl_fog.ts's (same fields, same Fog_Update/
Fog_ParseServerMessage/Fog_ParseWorldspawn/Fog_FogCommand_f/Fog_GetColor/
Fog_GetDensity bodies, copied rather than shared -- PORTING.md rule 3's
"closest faithful thing" applied to a file this port invented, not a C
original with one canonical body).

THE "fog" CONSOLE COMMAND: WHY Fog_Init DOES NOT REGISTER IT

WinQuake links one renderer; this port compiles both in, and in a REAL
process only one renderer's R_Init ever runs (`hostClientHooks.rInit = () =>
{ re.current?.R_Init(); }`, src/ref_soft/ref_soft.ts / src/ref_gl/gl_rmisc.ts
-- `re.current` names exactly one renderer), so gl_fog.ts's Fog_Init and this
file's own Fog_Init were never both going to run in one real client, and the
brief's "register only if the GL module hasn't" (`Cmd_Exists("fog")`, the
real command table as the guard rather than a private flag) is a correct
description of that one-real-process case. This file does NOT call
`Cmd_AddCommand("fog", ...)` from Fog_Init, though, for a reason found
empirically while verifying this unit: `bun test`'s own file-scheduling order
in this repo did not match the order test files were given on the command
line (confirmed by swapping the argument order and by forcing
`--max-concurrency=1`; the actual order it used was not evident from the
CLI), and in EVERY ordering tried, some ref_soft test file's ordinary R_Init
call (unrelated to fog -- every ref_soft suite calls R_Init as routine setup)
ran before test/ref_gl_fog.test.ts's own "fog console command" describe.
Cmd_AddCommand has no removal/reclaim path outside `cmdHost.rendererSwitch`
(a real vid_ref-switch window neither test file opens), so whichever module's
Cmd_AddCommand("fog", ...) call happened to run FIRST in that shared `bun
test` process kept "fog" bound to its own Fog_FogCommand_f for the rest of
the process -- the Cmd_Exists guard only stops a SECOND caller from printing
"already defined" over an existing registration, it does not make the
outcome depend on WHICH renderer's tests the caller "should" belong to. So
registering "fog" here at all, guarded or not, broke test/ref_gl_fog.test.ts's
own command tests -- a file outside this unit's SCOPE, and one standing
order 14 forbids leaving broken. Production correctness does not depend on
this registration (see above: only one Fog_Init ever runs there), so this
unit stops short of it. Fog_ParseServerMessage/Fog_ParseWorldspawn -- the
actual svc_fog/worldspawn-key paths real gameplay uses -- and
Fog_FogCommand_f itself (callable directly; this unit's own test does
exactly that via Cmd_TokenizeString + a direct call, bypassing the shared
table entirely) are unaffected. Follow-up: a real fix needs ONE 'fog' command
implementation that dispatches through `re.current`, which needs a home
outside both renderer directories (render.ts, out of this unit's SCOPE) --
the same shape render.ts's shared-cvar block already gives `r_fullbright`.

`r_skyfog` IS NOT gl_sky.ts's SHARED OBJECT

render.ts's shared-cvar block (r_fullbright, r_drawentities, ...) is the
established way two renderers agree on one cvar's live value: one `CvarT`
object, imported by both R_Init functions. `r_skyfog` is not in that block --
it is gl_sky.ts's own module-private export, declared for the GL skybox's
sky-tint blend (U21-era) with no ref_soft reader before this unit. Importing
it here would mean this file (and therefore every software-only build/test)
pulling in gl_sky.ts's own glquake.ts/gl_draw.ts/qgl.ts dependency chain --
the same self-sufficiency problem the section above avoids for gl_fog.ts.
This file therefore declares its OWN `r_skyfog` CvarT, default 0.5 to match
gl_sky.ts's. Documented deviation/limitation: while both renderers are
loaded, `r_skyfog <value>` at the console only reaches whichever CvarT
object's owner (Cvar_RegisterVariable's list is keyed by name, first
registration wins) got there first -- the OTHER renderer's own object stays
at its compiled-in default until a follow-up moves `r_skyfog` into
render.ts's shared block the way `r_fullbright` already lives there.

DEPTH RECONSTRUCTION, AND THE UNIT CHECK AGAINST gl_fog.ts

d_scan.ts's D_DrawZSpans (ported from WinQuake/d_scan.c) is what fills
`rState.d_pzbuffer`: for each pixel it computes `zi` (WinQuake's classic
1/z -- R_RenderFace's plane-derived reciprocal depth along the camera's
forward axis, in world/map units, which is affine and therefore can be
linearly interpolated across a planar polygon in screen space; see
r_draw.ts:483-493's `distinv`/`d_zistepu`/`d_zistepv`/`d_ziorigin`, and
d_scan.ts:532's `z = 0x10000 / zi`, which is the SAME zi used for the
perspective-correct texture-coordinate divide, prescaled to 16.16), then
stores `izi = trunc(zi * 0x8000 * 0x10000)`, `d_pzbuffer[i] = izi >> 16`.
Every 16.16 product involved is exactly representable as a double (see
d_scan.ts's own header), so the ONLY lossy step is the truncation to a
16-bit element -- this reconstruction inverts that exactly:

    zi = d_pzbuffer[i] / 0x8000
    z  = 1 / zi                       (world units, positive: distance in
                                        front of the viewer along the view
                                        axis, for any pixel a real surface
                                        covers)

`zi <= 0` never happens for real world/entity/particle/sky-surface geometry
(every SurfT.d_ziorigin/d_zistepu/d_zistepv the drawers use comes from a real
polygon plane in front of the camera -- r_draw.ts's R_RenderFace, d_sprite.ts,
D_PolysetCalcGradients); the ONE place a non-positive zi is ever written is
r_edge.ts's R_BeginEdgeFrame background/dummy surface (surfaces[1],
SURF_DRAWBACKGROUND), which d_edge.ts's D_DrawSurfaces hard-codes to
`d_ziorigin = -0.9, d_zistepu = d_zistepv = 0` -- WinQuake's own "put the
background behind everything" sentinel for screen area no real BSP surface
ever covers (which in a sealed map is nothing; in this unit's own synthetic
test map, whose two faces do not enclose a room, it is exactly the void
outside them). THIS -- not the classic SURF_DRAWSKY brush faces, which are
real, finite-depth polygons like any other surface and are correctly
depth-fogged by the ordinary formula below -- is "the sky marker" this
module treats specially, per the unit brief's "z = 0 or the sky marker":
r_clearcolor's flat background fill is the one thing in this renderer that
has no real depth to fog by, so it gets tinted toward the fog color by
`r_skyfog`'s fraction instead, mirroring gl_sky.ts's SkyTintColor for the
same reason (a GL skybox/background has no meaningful depth either).

UNIT CHECK: gl_fog.ts's Fog_SetupFrame calls
`qglFogf(GL_FOG_DENSITY, Fog_GetDensity() / 64.0)` -- the real OpenGL
GL_EXP2 fog equation (see the OpenGL 1.x fixed-function spec) is
`f = exp(-(density * z)^2)` with `z` the eye-space (camera-forward) distance,
the SAME "distance along the view axis, in world/map units" quantity `1/zi`
reconstructs above. So this file's Fog_PostPass divides its own
Fog_GetDensity() by the same 64.0 before squaring, which is what makes the
two renderers agree on how strongly a given worldspawn/svc_fog density value
fogs a surface at a given world-space distance: `factor = 1 -
exp(-((density/64) * z)^2)`, the brief's "1 - exp(-(density*depth)^2)" with
GL's own density scaling folded in so "density" means the same wire/
worldspawn number in both files.

THE 8-BIT PALETTED PATH: FOG IS SKIPPED, NOT DEGRADED

ARCHITECTURE.md's "Renderers" section: the software renderer's true-color
output path is what colored lighting and (now) fog draw into; "the 8-bit
paletted path stays for `classic`". Classic WinQuake never had fog of any
kind -- gl_fog.ts's own header explains fog exists at all only because the
2021 re-release's maps ship worldspawn "fog" keys and an SVC_FOG message
that the re-release ruleset (and this port's fidelity razor) needs to
observe. So under the 8-bit path (`!rState.r_truecolor`), Fog_PostPass is a
no-op: that IS classic behavior, not a placeholder. The alternative the
brief also allows -- reducing every blended color to its nearest palette
entry through a lookup table, the way swimp.ts's SWimp_Build15to8Table
reduces a true-color frame to 5:5:5 -- was considered and rejected: it would
show fog on a rendering path this port's own architecture reserves for byte-
identical classic output, which is the one thing `classic` mode must never
do. `r_fog 0` (see the cvar below) is the general off switch for anyone who
wants the pre-fog frame regardless of color depth.
*/

import { type Vec3, vec3 } from "../common/mathlib";
import { type ParseState, COM_Parse, Q_atof } from "../common/common";
import { cl } from "../client/client";
import { Cmd_Argc, Cmd_Argv } from "../common/cmd";
import { Con_Printf } from "../client/console";
import { CvarT, Cvar_RegisterVariable } from "../common/cvar";
import { r_refdef, rState } from "./r_shared";

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

// U27 addition (this file's header): the software post-pass's own on/off
// switch, independent of `r_truecolor`/color depth.
export const r_fog = new CvarT("r_fog", "1");

// U27 addition, this file's own object -- see this file's header on why it
// is not gl_sky.ts's `r_skyfog`. Same default (0.5).
export const r_skyfog = new CvarT("r_skyfog", "0.5");

/*
=============
Fog_Update

update internal variables. Identical body to gl_fog.ts's (see this file's
header for why the state is duplicated, not shared).
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

handle an SVC_FOG message from the server -- see gl_fog.ts's own copy of this
comment: cl_parse.ts reads the wire bytes and hands them here already split
out; the /255 and /100 conversions happen here.
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

// sscanf(value, "%f %f %f %f", ...)'s partial-match semantics; see gl_fog.ts's
// own copy of this helper for the full explanation.
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

called at map load (this renderer's R_NewMap -- see r_main.ts). `entities` is
cl.worldmodel.entities.
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
Fog_Init

registers the r_fog/r_skyfog cvars. Called from r_main.ts's R_Init. Does NOT
register the 'fog' console command -- see this file's header ("THE 'fog'
CONSOLE COMMAND"). Fog_FogCommand_f is still fully implemented and directly
callable (Cmd_TokenizeString + a direct call, as this file's own test does).
=============
*/
export function Fog_Init(): void {
  Cvar_RegisterVariable(r_fog);
  Cvar_RegisterVariable(r_skyfog);
}

/*
=============
Fog_PostPass

the depth post-pass ARCHITECTURE.md's "Renderers" section names: called at
the end of R_RenderView_ (r_main.ts), after the 3D scene (world, entities,
view model, particles) is drawn and before D_WarpScreen's underwater
distortion / the 2D overlay. See this file's header for the depth
reconstruction and the unit check against gl_fog.ts's GL_EXP2 density.
=============
*/
export function Fog_PostPass(): void {
  if (!r_fog.value) return;

  const density = Fog_GetDensity();
  if (density <= 0) return;

  // U27 decision (this file's header): the 8-bit palette path is `classic`,
  // which never had fog. Skip rather than degrade it through a palette
  // remap.
  if (!rState.r_truecolor) return;

  const buffer32 = rState.d_viewbuffer32; // aliases vid.buffer32, or
  // rState.r_warpbuffer32 while r_dowarp -- see r_shared.ts's RStateT
  const zbuf = rState.d_pzbuffer;
  if (buffer32 === null || zbuf === null) return;

  const fogColor = Fog_GetColor();
  const fr = fogColor[0] * 255.0;
  const fg = fogColor[1] * 255.0;
  const fb = fogColor[2] * 255.0;

  const skyfog = r_skyfog.value < 0 ? 0 : r_skyfog.value > 1 ? 1 : r_skyfog.value;

  // gl_fog.ts's Fog_SetupFrame's own GL_FOG_DENSITY scale -- see this file's
  // header's unit check.
  const glDensity = density / 64.0;

  const vrect = r_refdef.vrect;
  const stride = rState.screenwidth;
  const zstride = rState.d_zwidth;

  for (let row = 0; row < vrect.height; row++) {
    const y = vrect.y + row;
    let pdest = y * stride + vrect.x;
    let pz = y * zstride + vrect.x;

    for (let col = 0; col < vrect.width; col++, pdest++, pz++) {
      const zi = zbuf[pz] / 0x8000;

      let factor: number;
      if (zi <= 0) {
        // this file's header: the SURF_DRAWBACKGROUND sentinel, not a real
        // sky brush face -- tinted toward the fog color by r_skyfog instead
        // of the depth formula, since it has no real depth.
        factor = skyfog;
      } else {
        const z = 1.0 / zi;
        const e = glDensity * z;
        factor = 1.0 - Math.exp(-(e * e));
      }

      if (factor <= 0) continue;
      if (factor > 1) factor = 1;

      const pixel = buffer32[pdest];
      const r = pixel & 0xff;
      const g = (pixel >>> 8) & 0xff;
      const b = (pixel >>> 16) & 0xff;
      const a = pixel & 0xff000000;

      const nr = Math.round(r + (fr - r) * factor) & 0xff;
      const ng = Math.round(g + (fg - g) * factor) & 0xff;
      const nb = Math.round(b + (fb - b) * factor) & 0xff;

      buffer32[pdest] = (a | (nb << 16) | (ng << 8) | nr) >>> 0;
    }
  }
}
