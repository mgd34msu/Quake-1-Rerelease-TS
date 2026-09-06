// Cvars both renderers read under one name. PORTING.md's home for these is
// src/client/render.ts; this module exists so neither renderer imports the
// other (test/ref_gl_types.test.ts guards that boundary) and can be folded
// into render.ts by its owner. Registration happens once, at module load, so
// either renderer's module graph finds the cvar live -- including a
// software-only or dedicated-server process that never runs the GL
// renderer's own R_Init. U44: r_lerpmove/r_lerpmodels/r_nolerp_list/
// r_lerplightstyles moved here for exactly that reason -- only gl_rmisc.ts's
// R_Init ever registered them, so a software-only process left every one at
// CvarT's unregistered 0 value (cvar.ts's own header: "a cvar is 0 until
// registered, same as the C"), silently disabling interpolation. Every
// object below is re-exported, under its original name, by the module that
// used to own it (src/client/render.ts, src/ref_gl/glquake.ts,
// src/ref_gl/gl_sky.ts, src/ref_soft/r_main.ts, src/ref_soft/r_fog.ts,
// src/ref_gl/gl_rmain.ts), so no importer had to change.
import { CvarT, Cvar_RegisterVariable } from "./cvar";

// Ironwail's cvar name: MD5 (re-release) replacement models are loaded
// beside their .mdl when this is 1.
export const r_enhancedmodels = new CvarT("r_enhancedmodels", "1");
Cvar_RegisterVariable(r_enhancedmodels);

// U16 addition, no WinQuake counterpart: QuakeSpasm/Ironwail's r_lerpmove
// (gl_rmain.c's `cvar_t r_lerpmove = {"r_lerpmove", "1", CVAR_NONE};`),
// gating CL_RelinkEntities's (src/client/cl_main.ts) MOVETYPE_STEP
// step-smoothing versus WinQuake's classic per-frame lerp. Re-exported by
// src/client/render.ts (its original home).
export const r_lerpmove = new CvarT("r_lerpmove", "1");
Cvar_RegisterVariable(r_lerpmove);

// U16 addition, no WinQuake counterpart: QuakeSpasm/Ironwail's r_lerpmodels
// (gl_rmain.c's `cvar_t r_lerpmodels = {"r_lerpmodels", "1", CVAR_NONE};`).
// Re-exported by src/client/render.ts (its original home).
export const r_lerpmodels = new CvarT("r_lerpmodels", "1");
Cvar_RegisterVariable(r_lerpmodels);

// U16 addition, no WinQuake counterpart: QuakeSpasm's r_nolerp_list
// (gl_rmain.c) -- model names gl_rmain.ts's/src/ref_soft/r_alias.ts's
// alias-frame setup treats as MOD_NOLERP. Re-exported by
// src/ref_gl/glquake.ts (its original home).
export const r_nolerp_list = new CvarT(
  "r_nolerp_list",
  "progs/flame.mdl,progs/flame2.mdl,progs/braztall.mdl,progs/brazshrt.mdl,progs/longtrch.mdl,progs/flame_pyre.mdl,progs/v_saw.mdl,progs/v_xfist.mdl,progs/h2stuff/newfire.mdl",
);
Cvar_RegisterVariable(r_nolerp_list);

// Ironwail's r_lerplightstyles (gl_rlight.c): interpolate lightstyle values
// between animation frames (R_AnimateLight); >= 2 also interpolates abrupt
// swings (e.g. e1m1's flickering light). Re-exported by
// src/ref_gl/glquake.ts (its original home).
export const r_lerplightstyles = new CvarT("r_lerplightstyles", "1");
Cvar_RegisterVariable(r_lerplightstyles);

// QuakeSpasm's gl_sky.c cvars, ported without a WinQuake original (U21/U34):
// r_skyfog tints the sky toward the current fog color, r_fastsky skips the
// slow/textured sky draw for a flat fill, r_skyalpha is the skybox/cloud
// draw's alpha. Both renderers read these under one name -- see
// src/ref_gl/gl_sky.ts's and src/ref_soft/r_fog.ts's/r_main.ts's own headers
// for the per-renderer usage. Re-exported by gl_sky.ts (r_skyfog/r_fastsky/
// r_skyalpha), r_fog.ts (r_skyfog) and r_main.ts (r_fastsky/r_skyalpha).
export const r_skyfog = new CvarT("r_skyfog", "0.5");
Cvar_RegisterVariable(r_skyfog);

export const r_fastsky = new CvarT("r_fastsky", "0");
Cvar_RegisterVariable(r_fastsky);

export const r_skyalpha = new CvarT("r_skyalpha", "1");
Cvar_RegisterVariable(r_skyalpha);

// QuakeSpasm/Ironwail's r_wateralpha family (gl_rmain.c): translucent water
// (r_wateralpha) and its per-content-type overrides (r_lavaalpha/
// r_slimealpha/r_telealpha -- 0 means "not overridden, fall back to
// r_wateralpha"; see gl_rmain.ts's R_WaterAlphaForTextureName). GL-only
// reader today; moved here so the name is shared the moment a second reader
// needs it, matching r_enhancedmodels' pattern. Re-exported by gl_rmain.ts.
export const r_wateralpha = new CvarT("r_wateralpha", "1");
Cvar_RegisterVariable(r_wateralpha);

export const r_lavaalpha = new CvarT("r_lavaalpha", "0");
Cvar_RegisterVariable(r_lavaalpha);

export const r_slimealpha = new CvarT("r_slimealpha", "0");
Cvar_RegisterVariable(r_slimealpha);

export const r_telealpha = new CvarT("r_telealpha", "0");
Cvar_RegisterVariable(r_telealpha);
