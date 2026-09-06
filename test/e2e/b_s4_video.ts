// Usage: bun test/e2e/b_s4_video.ts <shotname> [engine args...] -- [console cmds...]
import { boot, frames, exec, check, summary, shot, keyState, Cvar_VariableString, Cvar_VariableValue } from "./b_lib";
import { KeydestT } from "../../src/client/keys";
import { vid } from "../../src/client/vid";
import { cl } from "../../src/client/client";
import { Q1TS_DATA } from "./q1data";

const argv = process.argv.slice(2);
const name = argv[0] ?? "video";
const sep = argv.indexOf("--");
const engineArgs = sep === -1 ? argv.slice(1) : argv.slice(1, sep);
const cmds = sep === -1 ? [] : argv.slice(sep + 1);

boot(["-basedir", Q1TS_DATA, "-game", "e2e_b", ...engineArgs]);
frames(5);
console.log(`  VID: ${vid.width}x${vid.height} vid_ref=${Cvar_VariableString("vid_ref")} vid_mode=${Cvar_VariableValue("vid_mode")} vid_fullscreen=${Cvar_VariableValue("vid_fullscreen")}`);
exec("disconnect", 3);
exec("map e1m1", 25);
keyState.key_dest = KeydestT.key_game;
exec("clear", 1);
frames(3);

for (const c of cmds) {
  if (c.startsWith("SHOT:")) {
    frames(6);
    shot(c.slice(5));
    continue;
  }
  if (c.startsWith("WAIT:")) {
    frames(Number(c.slice(5)));
    continue;
  }
  console.log(`  >>> ${c}`);
  try {
    exec(c, 8);
  } catch (e) {
    console.log(`  !!! THREW on "${c}": ${String(e)}`);
  }
  frames(3);
  console.log(`  VID now: ${vid.width}x${vid.height} vid_ref=${Cvar_VariableString("vid_ref")} levelname=${JSON.stringify(cl.levelname)}`);
}

frames(Number(process.env.B_SETTLE_FRAMES ?? 40));
shot(name);
console.log(`  FINAL VID: ${vid.width}x${vid.height} vid_ref=${Cvar_VariableString("vid_ref")} levelname=${JSON.stringify(cl.levelname)}`);
summary(`S4 ${name}`);
process.exit(0);
