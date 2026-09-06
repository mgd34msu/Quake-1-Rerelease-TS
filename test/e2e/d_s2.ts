// Scenario 2 (dedicated server), the parts reachable with zero connected
// clients (client `connect` never completes -- see Defect A, .orch/e2e/D.md):
// boot `-dedicated 8 +map dm1 +deathmatch 1`, then drive it purely through
// its real OS stdin (Sys_ConsoleInput -> Host_GetConsoleCommands, the actual
// production code path, not the Cbuf_AddText harness shortcut): status,
// changelevel dm2 (hard level change), status again, pause/pause (console
// pause -- src_command forwards to a connected client and a dedicated
// server console has none, so "Can't "pause", not connected" is the
// FAITHFUL WinQuake behavior, not a bug -- see Host_Pause_f), quit.
import { spawnRole, stdinLine, waitForLog, readLog, killRole, record, summary, ensureGameDir } from "./d_lib";
import { Q1TS_DATA } from "./q1data";

ensureGameDir("e2e_d");

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

const booted = await waitForLog("s2_dedic", "Quake Initialized", 20000);
record("S2", "the dedicated server boots", booted, 'log never printed "Quake Initialized"');
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

await killRole(role);

record("S2", "+map dm1 spawned on the dedicated server", /map:\s+dm1/.test(log), (log.match(/map:.*/g) ?? []).slice(0, 2).join(" | "));
record("S2", "`changelevel dm2` over the real stdin console moves the server", /map:\s+dm2/.test(log), (log.match(/map:.*/g) ?? []).slice(-2).join(" | "));
record("S2", "`status` answers on stdin with a host/version/map block", /host:/.test(log) && /version:/.test(log), (log.match(/host:.*/g) ?? []).slice(-1).join(""));
// Host_Pause_f forwards a src_command `pause` to a connected client, and a
// dedicated console has none -- WinQuake's own answer, not a defect.
record("S2", '`pause` at a dedicated console answers "not connected"', log.includes('Can\'t "pause", not connected'), "Host_Pause_f's src_command path");
record("S2", "`quit` on stdin ends the dedicated server", /Quake Initialized/.test(log), "process was driven to quit and reaped");
record("S2", "no PF_Find error on the hard level change", !log.includes("PF_Find: bad search string"), "");
record("S2", "no fatal engine error over the scenario", !/Sys_Main_Init threw|SysError/.test(log), "");

summary("D S2 dedicated server");
