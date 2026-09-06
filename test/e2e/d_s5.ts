// Scenario 5: loopback. Plain `+map dm1` (maxplayers defaults to 1, no
// `-listen`/`-dedicated`) never touches src/platform/net_udp.ts at all --
// the local client talks to its own server through src/common/net_loop.ts's
// in-process queue, so it is unaffected by Defect A (the real-UDP connect
// deadlock; see .orch/e2e/D.md). One process, one status showing "1 active
// (1 max)", one screenshot.
import { spawnRole, waitForLog, readLog, killRole, record, summary, ensureGameDir, waitRoleExit } from "./d_lib";
import { Q1TS_DATA } from "./q1data";

ensureGameDir("e2e_d");

const role = spawnRole({
  label: "s5_loopback",
  engineArgs: [
    "-basedir", Q1TS_DATA,
    "-game", "e2e_d",
    "-nosound",
    "+map", "dm1",
  ],
  script: [
    { atMs: 3000, cmd: "status" },
    { atMs: 4000, cmd: "screenshot" },
  ],
  runMs: 8000,
});

const booted = await waitForLog("s5_loopback", "Quake Initialized", 20000);
record("S5", "the loopback client boots", booted, 'log never printed "Quake Initialized"');
await waitRoleExit(role, 20000);
const log = readLog("s5_loopback");
console.log(log);

await killRole(role);

record("S5", "+map dm1 runs a single-player game over the in-process loopback", /players:\s*1 active \(1 max\)/.test(log), (log.match(/players:.*/g) ?? []).join(" | "));
record("S5", "`status` reports dm1 as the running map", /map:\s+dm1/.test(log), (log.match(/map:.*/g) ?? []).join(" | "));
// SCR_ScreenShot_f takes the first free quake00..quake99 name and the
// engine's -homedir default can redirect the write out of the retail tree,
// so COM_WriteFile's own line is what names the file to look for.
const s5Shot = /COM_WriteFile: (\S+quake\d\d\.pcx)/.exec(log);
record("S5", "the client wrote a screenshot of the loopback game", s5Shot !== null && (await Bun.file(s5Shot[1]).exists()), s5Shot !== null ? s5Shot[1] : "no COM_WriteFile line for a screenshot");
record("S5", "no fatal engine error over the scenario", !/Sys_Main_Init threw|SysError/.test(log), "");

summary("D S5 loopback");
