// Scenario 5: loopback. Plain `+map dm1` (maxplayers defaults to 1, no
// `-listen`/`-dedicated`) never touches src/platform/net_udp.ts at all --
// the local client talks to its own server through src/common/net_loop.ts's
// in-process queue, so it is unaffected by Defect A (the real-UDP connect
// deadlock; see .orch/e2e/D.md). One process, one status showing "1 active
// (1 max)", one screenshot.
import { spawnRole, waitForLog, readLog, killRole } from "./d_lib";
import { Q1TS_DATA } from "./q1data";

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

await waitForLog("s5_loopback", "EXIT", 12000);
const log = readLog("s5_loopback");
console.log(log);
console.log("\n--- checks ---");
console.log("map dm1 active, 1/1:", /players:\s*1 active \(1 max\)/.test(log));
console.log("screenshot written:", log.includes("Wrote quake00.pcx"));

await killRole(role);
process.exit(0);
