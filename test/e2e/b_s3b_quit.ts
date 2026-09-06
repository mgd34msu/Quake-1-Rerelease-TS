import { boot, frames, exec, check, summary, keyState, Cvar_VariableValue, asDest } from "./b_lib";
import { KeydestT } from "../../src/client/keys";
import { Q1TS_DATA } from "./q1data";

const BASE = Q1TS_DATA;
const mode = process.argv[2] ?? "quit";

boot(["-basedir", BASE, "-game", "e2e_b", "-nosound"]);
frames(5);
exec("disconnect", 3);
exec("map start", 15);

if (mode === "menu") {
  // `quit` with key_dest != key_console pops M_Menu_Quit_f instead of exiting
  keyState.key_dest = KeydestT.key_game;
  exec("quit", 3);
  check("quit from the game opens the quit menu, does not exit", asDest(keyState.key_dest) === KeydestT.key_menu, `key_dest=${keyState.key_dest}`);
  const { m_state } = require("../../src/client/menu");
  console.log("  menu state after quit:", JSON.stringify(m_state));
  // press N -> back to game
  const { Key_Event } = require("../../src/client/keys");
  Key_Event("n".charCodeAt(0), true);
  Key_Event("n".charCodeAt(0), false);
  frames(2);
  check("N in the quit dialog returns to the game", keyState.key_dest === KeydestT.key_game, `key_dest=${keyState.key_dest}`);
  summary("S3b quit menu");
  process.exit(0);
}

// quit from the console: CL_Disconnect + Host_ShutdownServer + Sys_Quit,
// and Host_Shutdown writes config.cfg on the way out.
console.log("  reading back sensitivity:", Cvar_VariableValue("sensitivity"));
exec("sensitivity 7", 1);
exec('bind p "echo b_config_marker"', 1);
exec("viewsize 90", 1);
keyState.key_dest = KeydestT.key_console;
console.log("  about to quit, key_dest =", keyState.key_dest);
exec("quit", 5);
console.log("  STILL RUNNING AFTER quit -- Sys_Quit did not exit the process");
process.exit(3);
