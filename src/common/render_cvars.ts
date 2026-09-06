// Cvars both renderers read under one name. PORTING.md's home for these is
// src/client/render.ts; this module exists so neither renderer imports the
// other (test/ref_gl_types.test.ts guards that boundary) and can be folded
// into render.ts by its owner. Registration happens once, at module load,
// so either renderer's module graph finds the cvar live.
import { CvarT, Cvar_RegisterVariable } from "./cvar";

// Ironwail's cvar name: MD5 (re-release) replacement models are loaded
// beside their .mdl when this is 1.
export const r_enhancedmodels = new CvarT("r_enhancedmodels", "1");
Cvar_RegisterVariable(r_enhancedmodels);
