/*
No C original. U27's follow-up (see .orch/followups.md): WinQuake links one
renderer, so gl_fog.c and this port's software twin (src/ref_soft/r_fog.ts)
were never both going to register a 'fog' console command in the same real
process. This port compiles both renderers in, though, and both files used to
call `Cmd_AddCommand("fog", ...)` from their own R_Init -- src/ref_gl/gl_fog.ts
still did, until this unit; src/ref_soft/r_fog.ts's own header documents
finding, empirically, that doing so from BOTH sides broke whichever renderer's
test suite ran second in the same `bun test` process (Cmd_AddCommand has no
reclaim path outside a real vid_ref switch, so the first "fog" registration
in a shared process wins for good).

This module is the fix: ONE 'fog' command, registered here at module load
(the same "registered once, at module load" shape src/common/render_cvars.ts
already uses for r_enhancedmodels), that dispatches through the ACTIVE
renderer's own seam members (src/client/render.ts's `Renderer.fogCommand`/
`fogGetState`) instead of calling either renderer's Fog_FogCommand_f
directly. Each renderer's `fogCommand` is a plain passthrough to its own
Fog_FogCommand_f (GL: gl_fog.ts's; software: r_fog.ts's), which still read
the tokenized command line themselves via Cmd_Argc/Cmd_Argv -- `args` below
(the same argv this file's own loop already produced) is carried on the seam
call for a future body that prefers it, not read by either renderer's
current one.
*/

import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv } from "../common/cmd";
import { getRenderer } from "./render";

function Fog_Cmd_f(): void {
  const argc = Cmd_Argc();
  const args: string[] = [];
  for (let i = 0; i < argc; i++) args.push(Cmd_Argv(i));
  getRenderer().fogCommand?.(args);
}

Cmd_AddCommand("fog", Fog_Cmd_f);
