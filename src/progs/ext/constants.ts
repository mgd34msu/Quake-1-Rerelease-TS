/*
The 2021 re-release's plain numeric constants, in a module that imports
nothing.

They live apart from the modules that use them because src/progs/pr_cmds.ts
reads `SETCOLOR_BUILTIN` at module scope, while assembling its builtin table,
and src/progs/ext/qex.ts -- where the constant naturally belongs -- reaches
src/server/sv_main.ts and so is still initialising when pr_cmds.ts's own body
runs. A `const` in a partially-initialised module is in its temporal dead
zone, so the read threw `ReferenceError: Cannot access 'SETCOLOR_BUILTIN'
before initialization` on a real boot. PORTING.md's import-cycle rule resolves
such a pair at the less fundamental side; here both sides are equally
fundamental and the values are plain numbers, so they move to a leaf module
both can import unconditionally.

src/progs/ext/qex.ts and src/progs/ext/ruleset.ts re-export the ones that read
naturally as theirs, so call sites keep naming the module they belong to.
*/

// quakec_ctf/defs.qc:839 -- `void setcolor(entity client, float color) = #401`
export const SETCOLOR_BUILTIN = 401;

// quakec/defs.qc:444-445, the flag word ex_CheckPlayerEXFlags answers with
export const PEF_CHANGEONLYNEW = 1;
export const PEF_CHANGENEVER = 2;

// server.h's "entity effects" block gains the three 2021 re-release bits
// (Ironwail Quake/server.h:239-241, the values quakec/defs.qc:415-417 declares
// as EF_QUADLIGHT/EF_PENTALIGHT/EF_CANDLELIGHT).
export const EF_QEX_QUADLIGHT = 16;
export const EF_QEX_PENTALIGHT = 32;
export const EF_QEX_CANDLELIGHT = 64;

// The two gameplay constants the re-release adds past WinQuake's server.h
// blocks (quakec/defs.qc:278 and :286).
export const MOVETYPE_GIB = 11; // like MOVETYPE_BOUNCE, but with adjustable gravity
export const SOLID_CORPSE = 5; // reports touch and can shoot it, but not blocking otherwise.
