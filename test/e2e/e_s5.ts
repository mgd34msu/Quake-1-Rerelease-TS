// Scenario 5: demo record / stop / playdemo / timedemo / rerecord.
import { BASEDIR, CA_ACTIVE, REPO, bootClient, check, cl, cls, conMark, conSince, engineErrors, exec, execPump, pump, pumpUntil, serverReady, shot, startServer, summary } from "./e_lib";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";

const PORT = 27614;
for (const f of readdirSync(`${BASEDIR}/qw`)) if (/\.qwd$/i.test(f)) rmSync(`${BASEDIR}/qw/${f}`, { force: true });

const sv = startServer("s5_sv", ["-port", String(PORT), "+map", "dm3"]);
check("5.0 qwsv boots", await serverReady(sv));
await bootClient(["-ip", "127.0.0.1", "+connect", `127.0.0.1:${PORT}`]);
check("5.1 client reaches ca_active", await pumpUntil(() => cls.state === CA_ACTIVE, 25000), `cls.state=${cls.state}`);
await pump(2000);

// ---- record ---------------------------------------------------------------
{
  const cm = conMark();
  await execPump("record e2e", 1000);
  check("5.2 `record e2e` starts recording", conSince(cm).some((l) => /recording|Recording/.test(l)) || cls.demorecording, `client="${conSince(cm).join(" | ").slice(0, 200)}" demorecording=${cls.demorecording}`);

  exec("+forward");
  await pump(4000);
  exec("-forward");
  await pump(600);
  exec("+left");
  await pump(3000);
  exec("-left");
  await pump(2500);

  const cm2 = conMark();
  await execPump("stop", 1500);
  const path = `${BASEDIR}/qw/e2e.qwd`;
  const size = existsSync(path) ? statSync(path).size : -1;
  check("5.3 `stop` writes a non-empty qw/e2e.qwd", size > 1000, `size=${size} client="${conSince(cm2).join(" | ").slice(0, 160)}"`);
}

// ---- rerecord -------------------------------------------------------------
{
  const cm = conMark();
  await execPump("rerecord e2e2", 3000);
  const back = await pumpUntil(() => cls.state === CA_ACTIVE, 25000);
  await pump(4000);
  await execPump("stop", 1500);
  const path = `${BASEDIR}/qw/e2e2.qwd`;
  const size = existsSync(path) ? statSync(path).size : -1;
  check("5.4 `rerecord` reconnects and records a second demo", back && size > 500, `reconnected=${back} size=${size} client="${conSince(cm).join(" | ").slice(0, 200)}"`);
}

sv.kill(9);
await pump(800);

// ---- playdemo in a fresh client process, no server ------------------------
async function drive(args: string[], script: string[]): Promise<string> {
  const proc = Bun.spawn(["bun", `${REPO}/test/e2e/e_c2.ts`, "-basedir", BASEDIR, "-nosound", "-ip", "127.0.0.2", ...args], {
    cwd: REPO,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" },
  });
  let out = "";
  const dec = new TextDecoder();
  const drain = async (s: ReadableStream<Uint8Array>): Promise<void> => {
    for await (const c of s) out += dec.decode(c);
  };
  void drain(proc.stdout);
  void drain(proc.stderr);
  const boot0 = Date.now();
  while (!out.includes("[c2] booted") && Date.now() - boot0 < 40000) await Bun.sleep(100);
  if (!out.includes("[c2] booted")) {
    try { proc.kill(9); } catch { /* gone */ }
    return out;
  }
  for (const line of script) {
    proc.stdin.write(line + "\n");
    proc.stdin.flush();
  }
  proc.stdin.write("?quit\n");
  proc.stdin.flush();
  const t = Date.now();
  while (!out.includes("[c2] done") && Date.now() - t < 60000) await Bun.sleep(150);
  try {
    proc.kill(9);
  } catch {
    /* gone */
  }
  return out;
}

{
  const out = await drive([], ["@1500", "playdemo e2e", "@6000", "?state", "?con", "screenshot", "@2000", "?con"]);
  const state = /\[c2state\] (\d+) active=(\w+)/.exec(out);
  check("5.5 `playdemo e2e` in a fresh client with no server reaches ca_active", state?.[2] === "true", `cls.state=${state?.[1]} con=${(/\[c2con\] (.*)/.exec(out)?.[1] ?? "").slice(0, 260)}`);
  const shots = readdirSync(`${BASEDIR}/qw`).filter((f) => /^quake\d+\.pcx$/.test(f));
  check("5.6 a screenshot came out of demo playback", /Wrote quake/.test(out) || shots.length > 0, `wrote=${/Wrote quake\d+/.exec(out)?.[0] ?? "none"}`);
}
{
  const out = await drive([], ["@1500", "timedemo e2e", "@15000", "?con"]);
  check("5.7 `timedemo e2e` prints a frames/seconds/fps line", /frames.*seconds.*fps|[\d.]+ fps/i.test(out), (/\[c2con\] (.*)/.exec(out)?.[1] ?? out.slice(-260)).slice(0, 300));
}

check("5.8 no uncaught engine exceptions in the recording client", engineErrors.length === 0, engineErrors.map((e) => e.split("\n")[0]).join(" ;; ").slice(0, 200));
summary("s5");
process.exit(0);
