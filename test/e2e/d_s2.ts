// Scenario 2 (dedicated server), the parts reachable with zero connected
// clients (client `connect` never completes -- see Defect A, .orch/e2e/D.md):
// boot `-dedicated 8 +map dm1 +deathmatch 1`, then drive it purely through
// its real OS stdin (Sys_ConsoleInput -> Host_GetConsoleCommands, the actual
// production code path, not the Cbuf_AddText harness shortcut): status,
// changelevel dm2 (hard level change), status again, pause/pause (console
// pause -- src_command forwards to a connected client and a dedicated
// server console has none, so "Can't "pause", not connected" is the
// FAITHFUL WinQuake behavior, not a bug -- see Host_Pause_f), quit.
import { spawnRole, stdinLine, waitForLog, readLog, killRole } from "./d_lib";
import { Q1TS_DATA } from "./q1data";

const PORT = 26120;
const role = spawnRole({
  label: "s2_dedic",
  engineArgs: [
    "-basedir", Q1TS_DATA,
    "-game", "e2e_d",
    "-dedicated", "8",
    "-port", String(PORT),
    "+map", "dm1",
    "+deathmatch", "1",
  ],
  script: [],
  runMs: 15000,
});

await waitForLog("s2_dedic", "Quake Initialized", 8000);
await Bun.sleep(1500);
await stdinLine(role, "status");
await Bun.sleep(1500);
await stdinLine(role, "changelevel dm2");
await Bun.sleep(2500);
await stdinLine(role, "status");
await Bun.sleep(1500);
await stdinLine(role, "pause");
await Bun.sleep(500);
await stdinLine(role, "pause");
await Bun.sleep(1000);
await stdinLine(role, "quit");
await Bun.sleep(2000);

const log = readLog("s2_dedic");
console.log(log);
console.log("\n--- checks ---");
console.log("map dm1 boot ok:", log.includes("map:     dm1"));
console.log("changelevel to dm2 ok:", log.includes("map:     dm2"));
console.log("PF_Find error observed on changelevel:", log.includes("PF_Find: bad search string"));
console.log("pause forwarded/rejected as faithful console-source behavior:", log.includes('Can\'t "pause", not connected'));

await killRole(role);
process.exit(0);
