// Scenario 1: listen server. Process A (`-listen 4 +map dm3`, a client that
// also hosts) + process B (`-port <port> +connect 127.0.0.1`). Real UDP on
// 127.0.0.1:26101 between two separate OS processes.
//
// NetQuake's `connect` takes a host only -- WinQuake's COM_Parse makes `:`
// its own token, so `connect 127.0.0.1:26101` would reach Host_Connect_f as
// the bare string "127.0.0.1" with the port silently dropped. The port the
// client resolves to comes from its own `net_hostport` (net_main.c's
// NET_StringToAdr default when the address string carries no ":port"), so
// role B's `-port` parm must be set to role A's listen port instead of its
// own.
import { spawnRole, waitForLog, readLog, killRole, record, results } from "./d_lib";
import { Q1TS_DATA } from "./q1data";

const PORT = 26101;
const RUN_MS = 20000;

const roleA = spawnRole({
  label: "s1_A",
  engineArgs: [
    "-basedir", Q1TS_DATA,
    "-game", "e2e_d",
    "-listen", "4",
    "-port", String(PORT),
    "-nosound",
    "+map", "dm3",
  ],
  script: [
    { atMs: 6000, cmd: "status" },
    { atMs: 10000, cmd: "status" },
    { atMs: 13000, cmd: "status" },
  ],
  runMs: RUN_MS,
});

await waitForLog("s1_A", "Quake Initialized", 10000);
await Bun.sleep(1500);

const roleB = spawnRole({
  label: "s1_B",
  engineArgs: [
    "-basedir", Q1TS_DATA,
    "-game", "e2e_d2",
    "-port", String(PORT),
    "-nosound",
    "+connect", "127.0.0.1",
  ],
  script: [
    { atMs: 5000, cmd: "status" },
    { atMs: 6000, cmd: "screenshot" },
    { atMs: 7000, cmd: "say hello" },
    { atMs: 12000, cmd: "status" },
    { atMs: 15000, cmd: "disconnect" },
    { atMs: 16000, cmd: "reconnect" },
  ],
  runMs: RUN_MS,
});

await Bun.sleep(RUN_MS + 3000);

const logA = readLog("s1_A");
const logB = readLog("s1_B");

record("S1", "A boots and maps dm3", logA.includes("Quake Initialized") && logA.includes("map:     dm3"), "");
record("S1", "B reaches signon / entered the game (either side's log)", logA.includes("entered the game") || logB.toLowerCase().includes("connected"), "");
record("S1", "A status shows 2 players at some point", /players:\s*2 active/.test(logA), "");
record("S1", "B's say reaches A's console (\"hello\")", logA.includes("hello"), "");
record("S1", "B took a screenshot (quake00.pcx on disk)", await Bun.file(`${Q1TS_DATA}/e2e_d2/quake00.pcx`).exists(), "");
record("S1", "reconnect succeeded (no fatal error after)", !logB.includes("Sys_Main_Init threw"), "");

console.log("\n=== s1_A tail ===\n" + logA.slice(-4000));
console.log("\n=== s1_B tail ===\n" + logB.slice(-4000));

await killRole(roleA);
await killRole(roleB);

console.log("\nS1 RESULTS:", JSON.stringify(results.filter((r) => r.scenario === "S1"), null, 2));
process.exit(0);
