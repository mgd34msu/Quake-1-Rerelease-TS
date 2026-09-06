// Scenario 8: robustness -- a client vanishing, a server vanishing, a dead
// port, connect-while-connected, and a malformed out-of-band packet.
import { BASEDIR, CA_ACTIVE, REPO, bootClient, check, cls, conMark, conSince, engineErrors, execPump, pump, pumpUntil, serverReady, startServer, summary } from "./e_lib";

const PORT = 27616;
const DEAD = 27699;

function spawnClient2(args: string[]): { proc: import("bun").Subprocess<"pipe", "pipe", "pipe">; out: () => string } {
  const proc = Bun.spawn(["bun", `${REPO}/test/e2e/e_c2.ts`, "-basedir", BASEDIR, "-nosound", ...args], {
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
  return { proc, out: () => out };
}

// ---- 8.1 SIGKILL a client; the server times it out ------------------------
{
  const sv = startServer("s8a_sv", ["-port", String(PORT), "+map", "dm3"]);
  check("8.0 qwsv boots", await serverReady(sv));
  sv.send("timeout 5");
  await Bun.sleep(700);

  const c2 = spawnClient2(["-ip", "127.0.0.2", "+connect", `127.0.0.1:${PORT}`]);
  const t0 = Date.now();
  while (!c2.out().includes("[c2] booted") && Date.now() - t0 < 40000) await Bun.sleep(150);
  c2.proc.stdin.write("@8000\n?state\n");
  c2.proc.stdin.flush();
  const t1 = Date.now();
  while (!/\[c2state\]/.test(c2.out()) && Date.now() - t1 < 40000) await Bun.sleep(150);
  check("8.1a the second client connected", /\[c2state\] 5 active=true/.test(c2.out()), (/\[c2state\].*/.exec(c2.out())?.[0] ?? "").slice(0, 80));

  const m = sv.mark();
  c2.proc.kill(9);
  const dropped = await sv.waitFor("timed out", 45000);
  check("8.1b the server drops a SIGKILLed client after `timeout 5`", dropped, sv.since(m).replace(/\n/g, " | ").slice(0, 220));
  check("8.1c the server is still alive after the drop", sv.proc.exitCode === null, `exitCode=${sv.proc.exitCode}`);
  sv.kill(9);
  await Bun.sleep(500);
}

// ---- 8.2 kill the server; the client notices ------------------------------
{
  const sv = startServer("s8b_sv", ["-port", String(PORT + 1), "+map", "dm3"]);
  await serverReady(sv);
  await bootClient(["-ip", "127.0.0.1", "+connect", `127.0.0.1:${PORT + 1}`]);
  check("8.2a client reaches ca_active", await pumpUntil(() => cls.state === CA_ACTIVE, 25000), `cls.state=${cls.state}`);
  await pump(1500);

  const before = engineErrors.length;
  const cm = conMark();
  sv.kill(9);
  const noticed = await pumpUntil(() => cls.state !== CA_ACTIVE, 30000);
  const seen = conSince(cm).join(" | ");
  check("8.2b the client notices the server went away", noticed, `cls.state=${cls.state} client="${seen.slice(0, 260)}"`);
  check("8.2c the client survives the server going away (no uncaught throw)", engineErrors.length === before, engineErrors.length > before ? engineErrors[before].split("\n").slice(0, 4).join(" / ") : "");
  await pump(1500);
}

// ---- 8.3 connect to a dead port -------------------------------------------
{
  const before = engineErrors.length;
  const cm = conMark();
  await execPump(`connect 127.0.0.1:${DEAD}`, 800);
  await pump(9000);
  const seen = conSince(cm).join(" | ");
  const retrying = /Connecting to|No response|challenge/i.test(seen);
  check("8.3a connecting to a dead port retries instead of wedging", retrying && cls.state !== CA_ACTIVE, `cls.state=${cls.state} client="${seen.slice(0, 240)}"`);
  check("8.3b no uncaught throw while retrying a dead port", engineErrors.length === before, engineErrors.length > before ? engineErrors[before].split("\n").slice(0, 4).join(" / ") : "");

  const cm2 = conMark();
  await execPump("disconnect", 1500);
  await pump(5000);
  const after = conSince(cm2).join(" | ");
  const stopped = !/Connecting to/.test(after);
  check("8.3c `disconnect` stops the retry loop", stopped, `after-disconnect console="${after.slice(0, 200)}"`);
}

// ---- 8.4 connect while connected ------------------------------------------
{
  const sv = startServer("s8c_sv", ["-port", String(PORT + 2), "+map", "dm3"]);
  await serverReady(sv);
  await execPump(`connect 127.0.0.1:${PORT + 2}`, 800);
  check("8.4a client connected", await pumpUntil(() => cls.state === CA_ACTIVE, 25000), `cls.state=${cls.state}`);
  await pump(1500);

  const before = engineErrors.length;
  await execPump(`connect 127.0.0.1:${PORT + 2}`, 800);
  const back = await pumpUntil(() => cls.state === CA_ACTIVE, 25000);
  check("8.4b `connect` while already connected re-establishes the session", back, `cls.state=${cls.state}`);
  check("8.4c no uncaught throw on connect-while-connected", engineErrors.length === before, engineErrors.length > before ? engineErrors[before].split("\n").slice(0, 4).join(" / ") : "");
  await pump(1000);

  // ---- 8.5 malformed out-of-band packet -----------------------------------
  {
    const m = sv.mark();
    await execPump(`packet 127.0.0.1:${PORT + 2} garbage_command_xyz`, 2500);
    await execPump(`packet 127.0.0.1:${PORT + 2} "\\xff\\xff\\xff\\xffgarbage"`, 2500);
    await pump(2000);
    check("8.5 a garbage out-of-band packet does not kill the server", sv.proc.exitCode === null && cls.state === CA_ACTIVE, `svExit=${sv.proc.exitCode} cls.state=${cls.state} server="${sv.since(m).replace(/\n/g, " | ").slice(0, 220)}"`);
  }
  sv.kill(9);
  await pump(500);
}

check("8.z engine exception total for scenario 8", engineErrors.length === 0, engineErrors.map((e) => e.split("\n")[0]).join(" ;; ").slice(0, 300));
summary("s8");
process.exit(0);
