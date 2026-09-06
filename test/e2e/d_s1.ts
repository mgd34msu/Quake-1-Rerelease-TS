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
import { spawnRole, waitForLog, readLog, killRole, record, summary, ensureGameDir } from "./d_lib";
import { Q1TS_DATA } from "./q1data";

const PORT = 26101;
const RUN_MS = 20000;

// The engine does not create a `-game` directory that is not already there,
// and its writers (config.cfg, screenshots) then silently write nothing.
ensureGameDir("e2e_d");
ensureGameDir("e2e_d2");

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

const aBooted = await waitForLog("s1_A", "Quake Initialized", 20000);
record("S1", "the listen server boots", aBooted, "log s1_A never printed \"Quake Initialized\"");
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

console.log("\n=== s1_A tail ===\n" + logA.slice(-4000));
console.log("\n=== s1_B tail ===\n" + logB.slice(-4000));

await killRole(roleA);
await killRole(roleB);

record("S1", "A boots and maps dm3", logA.includes("Quake Initialized") && /map:\s+dm3/.test(logA), `dm3 in status: ${/map:\s+dm3/.test(logA)}`);
record("S1", "B connects and enters A's game", logA.includes("entered the game"), 'A\'s console never printed "entered the game"');
record("S1", "A's status shows two connected players", /players:\s*2 active/.test(logA), (logA.match(/players:.*/g) ?? []).slice(-3).join(" | "));
record("S1", 'B\'s "say hello" reaches A\'s console', /hello/.test(logA), (logA.match(/.*hello.*/g) ?? []).slice(-2).join(" | "));
// SCR_ScreenShot_f picks the first free quake00..quake99 name, and the
// engine's -homedir default redirects writes out of a read-only retail
// install, so neither the file name nor the directory is known in advance --
// COM_WriteFile's own line names the exact path it took.
const shotLine = /COM_WriteFile: (\S+quake\d\d\.pcx)/.exec(logB);
record(
  "S1",
  "B wrote a screenshot of the connected game",
  shotLine !== null && (await Bun.file(shotLine[1]).exists()),
  shotLine !== null ? shotLine[1] : 'no "COM_WriteFile: ...quakeNN.pcx" line in B\'s log',
);
record("S1", "B's disconnect + reconnect leaves it in the game again", /Reconnecting|reconnect/i.test(logB) && !/Sys_Main_Init threw/.test(logB), (logB.match(/.*econnect.*/g) ?? []).slice(-2).join(" | "));
record("S1", "neither role hit a fatal engine error", !/Sys_Main_Init threw|SysError/.test(logA + logB), "");

summary("D S1 listen server");
