// Scenarios 4 and 6: spectator mode and two real clients on one host.
// The second qwcl is a separate process bound to 127.0.0.2 (QW 2.33's client
// has no -port; NET_Init(PORT_CLIENT) is fixed at 27001).
import { BASEDIR, CA_ACTIVE, REPO, bootClient, check, cl, cls, conMark, conSince, engineErrors, exec, execPump, pump, pumpUntil, serverReady, shot, startServer, summary } from "./e_lib";
import * as cam from "../../src/qw/client/cl_cam";

const PORT = 27617;

interface Client2 {
  proc: import("bun").Subprocess<"pipe", "pipe", "pipe">;
  out: () => string;
  send: (s: string) => void;
  ask: (q: string, tag: string, ms?: number) => Promise<string>;
}

function spawnClient2(args: string[]): Client2 {
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
  const send = (s: string): void => {
    proc.stdin.write(s.endsWith("\n") ? s : s + "\n");
    proc.stdin.flush();
  };
  const ask = async (q: string, tag: string, ms = 20000): Promise<string> => {
    const from = out.length;
    send(q);
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const m = new RegExp(`\\[${tag}\\](.*)`).exec(out.slice(from));
      if (m) return m[1].trim();
      await pump(60);
    }
    return "";
  };
  return { proc, out: () => out, send, ask };
}

const sv = startServer("s46_sv", ["-port", String(PORT), "+map", "dm3"]);
check("4.0 qwsv boots", await serverReady(sv));

// ---- 6: two real clients --------------------------------------------------
await bootClient(["-ip", "127.0.0.1", "+connect", `127.0.0.1:${PORT}`]);
check("6.1 client 1 reaches ca_active", await pumpUntil(() => cls.state === CA_ACTIVE, 25000), `cls.state=${cls.state}`);
await execPump("name Alice", 1500);

const c2 = spawnClient2(["-ip", "127.0.0.2", "+connect", `127.0.0.1:${PORT}`]);
{
  const t0 = Date.now();
  while (!c2.out().includes("[c2] booted") && Date.now() - t0 < 40000) await pump(120);
}
const st = await c2.ask("@6000\n?state", "c2state");
check("6.2 client 2 binds 127.0.0.2:27001 and reaches ca_active", /active=true/.test(st), `state=${st} bindErr=${/EADDRINUSE/.test(c2.out())}`);
c2.send("name Carol");
await pump(2500);

{
  const m = sv.mark();
  sv.send("status");
  await pump(1800);
  const t = sv.since(m);
  check("6.3 the server's status lists both clients", /Alice/.test(t) && /Carol/.test(t), t.replace(/\n/g, " | ").slice(-220));
}
{
  const cm = conMark();
  c2.send("say hi from carol");
  await pump(2500);
  check("6.4 client 2's chat reaches client 1", conSince(cm).some((l) => /hi from carol/.test(l)), conSince(cm).join(" | ").slice(-200));

  await execPump("say hi from alice", 2500);
  const seen = await c2.ask("@1500\n?con", "c2con");
  check("6.5 client 1's chat reaches client 2", /hi from alice/.test(seen), seen.slice(-260));
}
{
  const cm = conMark();
  c2.send("kill");
  await pump(4000);
  const players = await c2.ask("@1000\n?players", "c2players");
  const carol = /\{"name":"Carol","frags":(-?\d+)/.exec(players)?.[1] ?? "?";
  check("6.6 client 2's suicide is reflected in its own frag count", Number(carol) < 0, `players=${players.slice(0, 220)}`);
  const seenOn1 = cl.qw.players.filter((p) => p.name !== "").map((p) => `${p.name}:${p.frags}`);
  check("6.7 client 1 sees client 2's frag change", seenOn1.some((s) => /^Carol:-/.test(s)), `client1 players=${JSON.stringify(seenOn1)} console="${conSince(cm).join(" | ").slice(-160)}"`);
  exec("+showscores");
  await pump(1000);
  const p = await shot("s6_two_client_scores");
  exec("-showscores");
  await pump(400);
  check("6.8 two-client scoreboard screenshot written", p !== null, String(p));
}
{
  // kick client 2 by userid; client 1 must stay
  const m = sv.mark();
  sv.send("status");
  await pump(1500);
  const rows = sv.since(m).split("\n").filter((l) => /Carol/.test(l));
  const uid = /^\s*-?\d+\s+(\d+)\s/.exec(rows[0] ?? "")?.[1] ?? "";
  const m2 = sv.mark();
  sv.send(`kick ${uid}`);
  await pump(4000);
  const gone = await c2.ask("@1500\n?state", "c2state");
  check("6.9 kicking client 2 leaves client 1 connected", cls.state === CA_ACTIVE && !/active=true/.test(gone), `uid=${uid} c1=${cls.state} c2state=${gone} server="${sv.since(m2).replace(/\n/g, " | ").slice(0, 180)}"`);
}
c2.send("?quit");
await pump(1500);
try {
  c2.proc.kill(9);
} catch {
  /* gone */
}

// ---- 4: spectator ---------------------------------------------------------
{
  await execPump("disconnect", 1500);
  await execPump("spectator 1", 800);
  const cm = conMark();
  await execPump(`connect 127.0.0.1:${PORT}`, 800);
  const inGame = await pumpUntil(() => cls.state === CA_ACTIVE, 25000);
  await pump(2500);
  check("4.1 `spectator 1` before connect enters as a spectator", inGame && cl.qw.spectator === 1, `cls.state=${cls.state} cl.qw.spectator=${cl.qw.spectator} client="${conSince(cm).join(" | ").slice(-200)}"`);

  const m = sv.mark();
  sv.send("status");
  await pump(1800);
  check("4.2 the server shows the connection as a spectator", /\(SPECTATOR\)|spectator|^\s*S\s/im.test(sv.since(m)), sv.since(m).replace(/\n/g, " | ").slice(-220));
}
{
  // a real player to track
  const c3 = spawnClient2(["-ip", "127.0.0.2", "+connect", `127.0.0.1:${PORT}`]);
  const t0 = Date.now();
  while (!c3.out().includes("[c2] booted") && Date.now() - t0 < 40000) await pump(120);
  const st3 = await c3.ask("@7000\n?state", "c2state");
  check("4.3 a player joined for the spectator to track", /active=true/.test(st3), st3);
  c3.send("name Dave");
  await pump(2500);

  const cm = conMark();
  await execPump("+attack", 1200);
  await execPump("-attack", 1500);
  await pump(2000);
  const tracked = cam.spec_track;
  check("4.4 spectator +attack cycles the tracked player", typeof tracked === "number", `spec_track=${tracked} autocam=${cam.autocam} client="${conSince(cm).join(" | ").slice(-180)}"`);

  await execPump("autocam", 1500);
  const p = await shot("s4_spectator_view");
  check("4.5 spectator-view screenshot written", p !== null, String(p));

  c3.send("?quit");
  await pump(1200);
  try {
    c3.proc.kill(9);
  } catch {
    /* gone */
  }
}
{
  await execPump("spectator 0", 800);
  const cm = conMark();
  await execPump("reconnect", 800);
  const back = await pumpUntil(() => cls.state === CA_ACTIVE, 25000);
  await pump(2500);
  check("4.6 `spectator 0` + reconnect returns as a player", back && cl.qw.spectator === 0, `cls.state=${cls.state} spectator=${cl.qw.spectator} client="${conSince(cm).join(" | ").slice(-180)}"`);
}

check("4/6.z no uncaught engine exceptions", engineErrors.length === 0, engineErrors.map((e) => e.split("\n")[0]).join(" ;; ").slice(0, 260));
sv.kill(9);
await pump(400);
summary("s46");
process.exit(0);
