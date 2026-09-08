/*
No C original. gl_sky.c registers its Sky_SkyCommand_f from the GL renderer's
own Sky_Init, and src/ref_soft has a skybox loader of its own (r_main.ts's
SoftSky_LoadSkyBox) but never had a command at all, so `sky` did not exist
under the software renderer. This port compiles both renderers into one
binary, where a per-renderer Cmd_AddCommand of the same name is exactly the
breakage src/client/fog_cmd.ts's header documents for `fog`: Cmd_AddCommand
has no reclaim path outside a real vid_ref switch, so the first registration
in a shared process wins for good.

Same shape as fog_cmd.ts, then: ONE `sky` command, registered here at module
load, dispatching through the ACTIVE renderer's own seam member
(src/client/render.ts's Renderer.skyLoadSkyBox, which GL wires to
Sky_LoadSkyBox and software to SoftSky_LoadSkyBox). gl_sky.ts's Sky_Init no
longer registers one.

Deviation from gl_sky.c's Sky_SkyCommand_f: its argument-less form prints the
renderer's own current skybox name. The Renderer seam carries skyLoadSkyBox
and no getter, and neither the seam nor its two implementations are this
unit's to change, so the name printed here is the one this command last
requested -- a name that came from a map's worldspawn "sky"/"skyname" key
(Sky_NewMap) is not seen, and neither is a request that found no faces on
disk and left the renderer's skybox cleared.
*/

import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv } from "../common/cmd";
import { Con_Printf } from "./console";
import { getRenderer } from "./render";

let requestedName = "";

function Sky_Cmd_f(): void {
  if (Cmd_Argc() === 1) {
    // the renderer's own answer covers a skybox the worldspawn set; the name
    // last typed here is the fallback for a renderer without the seam
    Con_Printf('"sky" is "%s"\n', getRenderer().skyGetName?.() ?? requestedName);
    return;
  }
  requestedName = Cmd_Argv(1);
  getRenderer().skyLoadSkyBox?.(requestedName);
}

Cmd_AddCommand("sky", Sky_Cmd_f);
