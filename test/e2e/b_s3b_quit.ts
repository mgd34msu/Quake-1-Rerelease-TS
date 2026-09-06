import { boot, frames, exec, check, summary, keyState, Cvar_VariableValue, asDest } from "./b_lib";
import { KeydestT } from "../../src/client/keys";
import { existsSync, readFileSync } from "node:fs";
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
//
// Sys_Quit ends the process from inside `exec("quit")`, so nothing after it
// runs and the driver cannot print its own RESULT line the way every other
// one does. The observable being asserted IS that exit, and the two facts
// that make it a pass -- the process left with status 0, and Host_Shutdown
// wrote the cvars it was holding into config.cfg -- are both only knowable
// once it is on its way out. `process.on("exit")` is the last synchronous
// point where they can still be printed.
const CONFIG = `${BASE}/e2e_b/config.cfg`;
console.log("  reading back sensitivity:", Cvar_VariableValue("sensitivity"));
exec("sensitivity 7", 1);
exec('bind p "echo b_config_marker"', 1);
exec("viewsize 90", 1);
keyState.key_dest = KeydestT.key_console;
console.log("  about to quit, key_dest =", keyState.key_dest);

process.on("exit", (code: number) => {
  const wrote = existsSync(CONFIG) ? readFileSync(CONFIG, "latin1") : "";
  const facts: Array<[string, boolean, string]> = [
    ["`quit` from the console exits the process with status 0", code === 0, `exit code=${code}`],
    ["Host_Shutdown wrote config.cfg on the way out", wrote.length > 0, `${CONFIG} is ${wrote.length} bytes`],
    ['config.cfg carries the bind set before quitting', wrote.includes("b_config_marker"), "bind p \"echo b_config_marker\""],
    ["config.cfg carries sensitivity 7", /sensitivity\s+"?7/.test(wrote), "sensitivity"],
    ["config.cfg carries viewsize 90", /viewsize\s+"?90/.test(wrote), "viewsize"],
  ];
  let pass = 0;
  for (const [name, ok, note] of facts) {
    console.log(`[${ok ? "PASS" : "FAIL"}] ${name} :: ${note}`);
    if (ok) pass++;
  }
  console.log(`RESULT ${pass} ${facts.length - pass}`);
});

exec("quit", 5);
console.log("[FAIL] `quit` from the console exits the process :: still running after quit -- Sys_Quit did not exit");
console.log("RESULT 0 1");
process.exit(3);
