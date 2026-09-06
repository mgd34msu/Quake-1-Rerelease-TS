// G scenario 2b -- the `-nomouse` command-line switch.
import { BASE, boot, frames, exec, check, summary, inputState, drain } from "./g_lib";
import { IN_Commands, IN_Move, SDL_SetRelativeDeltaForTests, SDL_InputStateForTests } from "../../src/platform/sdl";
import { Cvar_SetValue } from "../../src/common/cvar";
import { UsercmdT } from "../../src/server/server";
import { cl } from "../../src/client/client";
import { YAW } from "../../src/common/quakedef";
import { COM_CheckParm } from "../../src/common/common";

boot(["-basedir", BASE, "-game", "e2e_g", "-nosound", "-nomouse"]);
frames(5);
exec("disconnect", 3);
exec("map e1m1", 20);
frames(3);
drain();

check("-nomouse is present on the command line", COM_CheckParm("-nomouse") !== 0, `COM_CheckParm=${COM_CheckParm("-nomouse")}`);

// vid_x.c's IN_Init returns early on -nomouse BEFORE setting mouse_avail, so
// mouse_avail is false straight out of Host_Init's own IN_Init call.
const st = SDL_InputStateForTests();
check("-nomouse keeps mouse_avail false (vid_x.c's own early return)", st.mouse_avail === false, `mouse_avail=${st.mouse_avail}`);

// _windowed_mouse no longer gates capture at all (see sdl.ts's
// wantMouseCapture/_windowed_mouse header comments): capture now follows
// window focus + key_dest/fullscreen, and -nomouse pre-empts all of that by
// leaving mouse_avail false, so IN_Commands returns at its very first line
// regardless of the cvar or key_dest (key_dest is key_game here, the
// default -- see keys.ts's initial keyState). Setting the cvar to 1 is kept
// only to prove it still cannot force a capture -nomouse has disabled.
Cvar_SetValue("_windowed_mouse", 1);
IN_Commands();
check("-nomouse keeps the mouse uncaptured regardless of _windowed_mouse or key_dest (vid_x.c's own early return)", inputState().mouse_active === false, `mouse_active=${inputState().mouse_active}`);

cl.viewangles[YAW] = 0;
const cmd = new UsercmdT();
SDL_SetRelativeDeltaForTests(60, 0);
IN_Move(cmd);
check("-nomouse: IN_Move ignores mouse deltas (vid_x.c's own early return)", cl.viewangles[YAW] === 0, `yaw=${cl.viewangles[YAW]}`);

summary("G2b -nomouse");
