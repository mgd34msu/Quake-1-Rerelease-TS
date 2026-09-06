/*
Q1 -- every entry of src/platform/vid.ts's VID_MODES table applies through
`vid_mode N; vid_restart`, in both the software and GL renderers: vid.width/
vid.height match the table entry, and the next screenshot has those exact
dimensions and is non-blank.

Not a bun:test suite -- run as:

  SDL_VIDEODRIVER=dummy     SDL_AUDIODRIVER=dummy bun test/e2e/q_modes.ts soft
  SDL_VIDEODRIVER=offscreen SDL_AUDIODRIVER=dummy bun test/e2e/q_modes.ts gl

No `-width`/`-height`/`-winsize` command-line parms are passed: vid.ts's own
resolveMode() lets those override vid_mode's table lookup for the whole
session (vid_x.c's own precedent), which would make every mode switch below a
no-op.

Env:
  Q1TS_DATA     engine -basedir (required; see test/e2e/q1data.ts)
  Q1TS_SCRATCH  where screenshots land (default /tmp/q1ts-tests)
*/
import { boot, frames, exec, check, finish, shot, decode, litFraction, GAME } from "./q_lib";
import { keyState, KeydestT } from "../../src/client/keys";
import { Cvar_VariableString } from "../../src/common/cvar";
import { vid } from "../../src/client/vid";
import { re } from "../../src/client/render";
import { VID_MODES, VID_GetModeInfo } from "../../src/platform/vid";

const REF = process.argv[2] === "gl" ? "gl" : "soft";
const SHOTDIR = process.env.Q_SHOTDIR ?? `${process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests"}/qmodes`;

// -window: q_window's quit child archives vid_fullscreen 1 into the shared
// e2e_q config, and a fullscreen-desktop window would replace every mode's
// size with the dummy driver's 1024x768.
boot(["-vid_ref", REF, "-window"]);
frames(5);
check("boot: requested refresh is active", (re.current?.isGL === true) === (REF === "gl"), `requested=${REF} active=${re.current?.isGL ? "gl" : "soft"} vid_ref=${Cvar_VariableString("vid_ref")}`);
if ((re.current?.isGL === true) !== (REF === "gl")) {
  console.log(`  ABORT: no ${REF} refresh available on this video driver`);
  finish(`Q1 modes (${REF})`);
  process.exit(2);
}

exec("map start", 30);
keyState.key_dest = KeydestT.key_game;
exec("clear", 1);
frames(20);

for (let m = 0; m < VID_MODES.length; m++) {
  const info = VID_GetModeInfo(m);
  if (!info) {
    check(`mode ${m}: VID_GetModeInfo has an entry`, false, "no table entry");
    continue;
  }
  const label = `mode ${m} (${VID_MODES[m].description})`;

  // Sys_Error (src/platform/sys.ts) runs hostShutdown() -- which tears down
  // the video backend -- BEFORE it throws, so a crash here leaves the
  // process in a state no further mode can be meaningfully tested from:
  // caught, logged with its full detail as this mode's own failure, and the
  // whole table walk stops there rather than reporting a string of
  // meaningless failures for every mode after it. Whatever ran before the
  // crash is still reported in full.
  try {
    exec(`vid_mode ${m}`, 2);
    exec("vid_restart", 25);
    frames(10);

    const activeIsGL = re.current?.isGL === true;
    if (activeIsGL !== (REF === "gl")) {
      check(`${label}: stayed on the requested refresh`, false, `vid_restart fell back to ${activeIsGL ? "gl" : "soft"} -- vid_ref cvar now ${Cvar_VariableString("vid_ref")}`);
      continue;
    }

    check(`${label}: vid.width/height match the table`, vid.width === info.width && vid.height === info.height, `got ${vid.width}x${vid.height}, want ${info.width}x${info.height}`);

    keyState.key_dest = KeydestT.key_game;
    exec("clear", 1);
    frames(10);
    const path = shot(`${REF}_mode${m}`, SHOTDIR);
    if (path === null) {
      check(`${label}: screenshot written`, false, "no file produced");
      continue;
    }
    const img = decode(path);
    check(`${label}: screenshot is ${info.width}x${info.height}`, img.width === info.width && img.height === info.height, `decoded ${img.width}x${img.height}`);
    const lit = litFraction(img);
    check(`${label}: screenshot is non-blank`, lit > 0.02, `lit fraction=${lit.toFixed(4)}`);
  } catch (e) {
    check(`${label}: applied and rendered without the engine throwing`, false, `${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    console.log(`  ABORT: engine threw at mode ${m} (${info.width}x${info.height}) -- video backend is torn down (Sys_Error runs hostShutdown before throwing), stopping the table walk here. Modes ${m + 1}-${VID_MODES.length - 1} were never reached.`);
    break;
  }
}

const fails = finish(`Q1 modes (${REF}, -game ${GAME})`);
process.exit(fails === 0 ? 0 : 1);
