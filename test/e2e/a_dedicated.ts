import { Q1TS_DATA, Q1TS_REPO } from "./q1data";
// Scenario 7: drive `bun src/main.ts -dedicated` via stdin console lines.
export {}; // top-level await requires this file to be a module (TS1375)

const REPO = Q1TS_REPO;
const BASEDIR = Q1TS_DATA;

const proc = Bun.spawn(
  ["bun", `${REPO}/src/main.ts`, "-basedir", BASEDIR, "-game", "e2e_a", "-nosound", "-dedicated", "2", "+map", "e1m1"],
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

async function send(line: string, waitMs = 2500): Promise<void> {
  console.log(`\n##A DEDICATED-CMD ${line}`);
  const mark = chunks.length;
  proc.stdin.write(line + "\n");
  proc.stdin.flush();
  await Bun.sleep(waitMs);
  console.log(`##A DEDICATED-OUT-BEGIN ${line}`);
  console.log(chunks.slice(mark).join(""));
  console.log(`##A DEDICATED-OUT-END ${line}`);
}

await Bun.sleep(6000);
console.log("##A DEDICATED-BOOT-BEGIN");
console.log(chunks.join(""));
console.log("##A DEDICATED-BOOT-END");

await send("status");
await send("edicts", 4000);
await send("maxplayers");
await send("changelevel e1m2", 5000);
await send("status");
await send("map dm3", 5000);
await send("status");
await send("maxplayers 4", 3000);
await send("say hello from e2e");
await send("version");
await send("quit", 3000);

await Bun.sleep(1500);
const exited = await Promise.race([proc.exited, Bun.sleep(5000).then(() => "timeout")]);
console.log(`##A DEDICATED-EXIT ${JSON.stringify(exited)}`);
try {
  proc.kill();
} catch {
  /* already gone */
}
console.log("[A] DONE");
process.exit(0);
