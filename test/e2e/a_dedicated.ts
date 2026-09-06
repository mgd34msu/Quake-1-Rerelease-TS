import { Q1TS_DATA, Q1TS_REPO } from "./q1data";
// Scenario 7: drive `bun src/main.ts -dedicated` via stdin console lines.
export {}; // top-level await requires this file to be a module (TS1375)

const REPO = Q1TS_REPO;
const BASEDIR = Q1TS_DATA;

// Standing order 19: a live gate runs OUR OWN COMPILED BINARY. The runner
// (test/e2e/run_all.ts) builds one and exports Q1TS_BINARY; running the
// source through bun is the fallback for driving this file by hand.
// A dedicated server binds a real UDP port. The default 26000 is whatever
// else on this host happens to be listening, so family A takes 26050 (below
// family D's 26100-26199 band, see test/e2e/README.md "Ports").
const PORT = process.env.A_PORT ?? "26050";
const BINARY = process.env.Q1TS_BINARY;
const engineCmd = BINARY !== undefined && BINARY !== "" ? [BINARY] : ["bun", `${REPO}/src/main.ts`];
console.log(`##A DEDICATED-ENGINE ${engineCmd.join(" ")}`);

const proc = Bun.spawn(
  [...engineCmd, "-basedir", BASEDIR, "-game", "e2e_a", "-norerelease", "-nosound", "-port", PORT, "-dedicated", "2", "+map", "e1m1"],
  {
    cwd: REPO,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" },
  },
);

const chunks: string[] = [];
const dec = new TextDecoder();
void (async () => {
  for await (const c of proc.stdout) chunks.push(dec.decode(c));
})();
void (async () => {
  for await (const c of proc.stderr) chunks.push(dec.decode(c));
})();

const results: Array<{ name: string; pass: boolean; note: string }> = [];
function check(name: string, pass: boolean, note = ""): void {
  results.push({ name, pass, note });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${note ? " :: " + note : ""}`);
}

/** Sends one console line and returns everything the server printed in reply. */
async function send(line: string, waitMs = 2500): Promise<string> {
  console.log(`\n##A DEDICATED-CMD ${line}`);
  const mark = chunks.length;
  proc.stdin.write(line + "\n");
  proc.stdin.flush();
  await Bun.sleep(waitMs);
  const out = chunks.slice(mark).join("");
  console.log(`##A DEDICATED-OUT-BEGIN ${line}`);
  console.log(out);
  console.log(`##A DEDICATED-OUT-END ${line}`);
  return out;
}

await Bun.sleep(6000);
const bootLog = chunks.join("");
console.log("##A DEDICATED-BOOT-BEGIN");
console.log(bootLog);
console.log("##A DEDICATED-BOOT-END");
check("the dedicated server boots and reaches the console", bootLog.includes("UDP Initialized"), bootLog.slice(-200).replace(/\n/g, " | "));
check("+map e1m1 spawned on the dedicated server", bootLog.includes("the Slipgate Complex") || bootLog.includes("e1m1"), "boot log names e1m1");

const s1 = await send("status");
check("`status` prints the host name and the map", /host:/.test(s1) && /map:/.test(s1), s1.trim().split("\n").slice(0, 4).join(" | "));

const ed = await send("edicts", 4000);
check("`edicts` dumps the edict list", /EDICT\s+\d+|edicts/i.test(ed), ed.trim().slice(0, 120).replace(/\n/g, " | "));

const mp = await send("maxplayers");
check("`maxplayers` with no argument reports the current value", /"maxplayers" is "2"/.test(mp), mp.trim().replace(/\n/g, " | "));
check("`status` reports the server's player slots", /players: \d+ active \(2 max\)/.test(s1), s1.trim().split("\n").slice(0, 6).join(" | "));

await send("changelevel e1m2", 5000);
const s2 = await send("status");
check("`changelevel e1m2` moves the dedicated server to e1m2", /map:\s+e1m2/.test(s2), s2.trim().split("\n").slice(0, 4).join(" | "));

await send("map dm3", 5000);
const s3 = await send("status");
check("`map dm3` moves the dedicated server to dm3", /map:\s+dm3/.test(s3), s3.trim().split("\n").slice(0, 4).join(" | "));

// WinQuake refuses a maxplayers change while a server is running, and keeps
// the slot count it started with.
const mp4 = await send("maxplayers 4", 3000);
const s4 = await send("status");
check("`maxplayers 4` is refused while the server is running", /can not be changed while a server is running/.test(mp4), mp4.trim().replace(/\n/g, " | "));
check("the refused change left the slot count alone", /players: \d+ active \(2 max\)/.test(s4), s4.trim().split("\n").slice(0, 6).join(" | "));

const said = await send("say hello from e2e");
check("`say` echoes the message on the server console", said.includes("hello from e2e"), said.trim().replace(/\n/g, " | "));

const ver = await send("version");
check("`version` prints a version banner", /Version|version/.test(ver) && ver.trim().length > 0, ver.trim().replace(/\n/g, " | "));

await send("quit", 3000);
await Bun.sleep(1500);
const exited = await Promise.race([proc.exited, Bun.sleep(5000).then(() => "timeout")]);
console.log(`##A DEDICATED-EXIT ${JSON.stringify(exited)}`);
check("`quit` ends the dedicated server process", exited === 0, `exit=${JSON.stringify(exited)}`);
try {
  proc.kill();
} catch {
  /* already gone */
}
console.log("[A] DONE");
const bad = results.filter((r) => !r.pass);
console.log(`\n===SUMMARY A dedicated=== ${results.length - bad.length}/${results.length} passed`);
for (const r of bad) console.log(`  FAIL: ${r.name} :: ${r.note}`);
console.log(`RESULT ${results.length - bad.length} ${bad.length}`);
process.exit(bad.length > 0 ? 1 : 0);
