/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/pmove.h (GNU GPL v2 or later).

Deviations from PORTING.md / the C source:
- pmove.h declares `movevars`, `pmove`, `onground`, `waterlevel` and
  `watertype` `extern`; pmove.c defines them. They live here, in the header
  module, rather than in pmove.ts, for the same reason `sv`/`svs` live in
  src/server/server.ts instead of sv_main.ts: pmovetst.c reads `pmove` (and
  the `extern vec3_t player_mins/player_maxs` that pmove.c defines), so
  putting the singletons in pmove.ts would make pmove.ts and pmovetst.ts a
  two-way import cycle. With them here the graph is one-way:
  pmove_types.ts <- pmovetst.ts <- pmove.ts. pmove.ts re-exports all of them
  so `import { pmove } from "./pmove"` also resolves, matching the C's
  "pmove.c defines these" placement.
- `onground`, `waterlevel`, `watertype` and pmove.c's file-scope `frametime`
  are plain C ints/floats that are reassigned, so they cannot be exported
  `const` bindings mutated in place. They become fields of the exported
  singleton `pmState` (PORTING.md's "small exported holder" rule for C
  globals that are reassigned).
- `usercmd_t` -> `QwUsercmdT` from src/qw/protocol.ts (QW protocol.h, unit
  Q001), imported rather than redeclared.
- `int touchindex[MAX_PHYSENTS]` -> `Int32Array(MAX_PHYSENTS)`. The C writes
  `pmove.touchindex[pmove.numtouch++]` with no bounds check; a JS typed-array
  store past the end is dropped where the C would scribble over the next
  struct field. One PlayerMove can push at most ten entries, so the guarded
  and unguarded forms never differ in practice.
- `int spectator` stays a number (not `boolean`): the C assigns it from
  `cl.spectator`/`sv_client->spectator` and only ever tests truth.
*/

import { type Vec3, vec3 } from "../common/mathlib";
import type { ModelT } from "../common/model";
import { QwUsercmdT } from "./protocol";

export class PmplaneT {
  normal: Vec3 = vec3();
  dist = 0;
}

export class PmtraceT {
  allsolid = false; // if true, plane is not valid
  startsolid = false; // if true, the initial point was in a solid area
  inopen = false;
  inwater = false;
  fraction = 0; // time completed, 1.0 = didn't hit anything
  endpos: Vec3 = vec3(); // final position
  plane: PmplaneT = new PmplaneT(); // surface normal at impact
  ent = 0; // entity the surface is on
}

export const MAX_PHYSENTS = 32;

export class PhysentT {
  origin: Vec3 = vec3();
  model: ModelT | null = null; // only for bsp models
  mins: Vec3 = vec3(); // only for non-bsp models
  maxs: Vec3 = vec3(); // only for non-bsp models
  info = 0; // for client or server to identify
}

export class PlayermoveT {
  sequence = 0; // just for debugging prints

  // player state
  origin: Vec3 = vec3();
  angles: Vec3 = vec3();
  velocity: Vec3 = vec3();
  oldbuttons = 0;
  waterjumptime = 0;
  dead = false;
  spectator = 0;

  // world state
  numphysent = 0;
  physents: PhysentT[] = Array.from({ length: MAX_PHYSENTS }, () => new PhysentT()); // 0 should be the world

  // input
  cmd: QwUsercmdT = new QwUsercmdT();

  // results
  numtouch = 0;
  touchindex: Int32Array = new Int32Array(MAX_PHYSENTS);
}

export class MovevarsT {
  gravity = 0;
  stopspeed = 0;
  maxspeed = 0;
  spectatormaxspeed = 0;
  accelerate = 0;
  airaccelerate = 0;
  wateraccelerate = 0;
  friction = 0;
  waterfriction = 0;
  entgravity = 0;
}

export const movevars = new MovevarsT();

export const pmove = new PlayermoveT();

// pmove.c's `int onground, waterlevel, watertype;` and `float frametime;`
export class PmStateT {
  onground = 0;
  waterlevel = 0;
  watertype = 0;
  frametime = 0;
}

export const pmState = new PmStateT();

export const player_mins: Vec3 = vec3(-16, -16, -24);
export const player_maxs: Vec3 = vec3(16, 16, 32);
