// Scenario 9: a 3-minute run with one idle client and one moving client,
// `status` on the server every 30 s, watching for errors and memory growth.
import { BASEDIR, CA_ACTIVE, REPO, bootClient, check, cl, cls, conMark, conSince, engineErrors, exec, pump, pumpUntil, serverReady, shot, startServer, summary } from "./e_lib";

const PORT = 27620;
const RUN_MS = 180000;

const sv = startServer("s9_sv", ["-port", String(PORT), "+map", "dm3"]);
check("9.0 qwsv boots", await serverReady(sv));

// client 1 (in-process): the mover
await bootClient(["-ip", "127.0.0.1", "+connect", `127.0.0.1:${PORT}`]);
check("9.1 mover client reaches ca_active", await pumpUntil(() => cls.state === CA_ACTIVE, 25000), `cls.state=${cls.state}`);
await pump(1500);
exec("name Mover");
await pump(1200);

// client 2 (subprocess): the idler
const idler = Bun.spawn(["bun", `${REPO}/test/e2e/e_c2.ts`, "-basedir", BASEDIR, "-nosound", "-ip", "127.0.0.2", "+connect", `127.0.0.1:${PORT}`], {
  cwd: REPO,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" },
});
let idlerOut = "";
const dec = new TextDecoder();
const drain = async (s: ReadableStream<Uint8Array>): Promise<void> => {
  for await (const c of s) idlerOut += dec.decode(c);
};
void drain(idler.stdout);
void drain(idler.stderr);
{
  const t0 = Date.now();
  while (!idlerOut.includes("[c2] booted") && Date.now() - t0 < 40000) await pump(150);
}
idler.stdin.write("@8000\nname Idler\n@2000\n?state\n");
idler.stdin.flush();
{
  const t0 = Date.now();
  while (!/\[c2state\]/.test(idlerOut) && Date.now() - t0 < 40000) await pump(150);
}
check("9.2 idler client reaches ca_active", /\[c2state\] 5 active=true/.test(idlerOut), (/\[c2state\].*/.exec(idlerOut)?.[0] ?? "").slice(0, 80));

const rss0 = process.memoryUsage().rss;
const heap0 = process.memoryUsage().heapUsed;
const start = Date.now();
let nextStatus = 30000;
let statusCount = 0;
const samples: string[] = [];
let yaw = 0;
const errAtStart = engineErrors.length;
const svMark = sv.mark();

while (Date.now() - start < RUN_MS) {
  // keep the idler's stdin alive so it does not block; it just pumps
  idler.stdin.write("@2000\n");
  idler.stdin.flush();

  yaw = (yaw + 37) % 360;
  cl.viewangles[1] = yaw;
  exec("+forward");
  await pump(1600);
  exec("-forward");
  await pump(400);

  const t = Date.now() - start;
  if (t >= nextStatus) {
    sv.send("status");
    statusCount++;
    nextStatus += 30000;
    await pump(1200);
    const mu = process.memoryUsage();
    samples.push(`t=${Math.round(t / 1000)}s rss=${(mu.rss / 1048576).toFixed(1)}MB heap=${(mu.heapUsed / 1048576).toFixed(1)}MB state=${cls.state}`);
    console.log("[sample]", samples[samples.length - 1]);
  }
}

const svTail = sv.since(svMark);
const mu = process.memoryUsage();
console.log("[samples]", JSON.stringify(samples));

check("9.3 both clients are still connected after 3 minutes", cls.state === CA_ACTIVE && sv.proc.exitCode === null && idler.exitCode === null, `mover=${cls.state} svExit=${sv.proc.exitCode} idlerExit=${idler.exitCode}`);
check("9.4 the server answered `status` on every 30 s tick", statusCount >= 5 && (svTail.match(/net address/g) ?? []).length >= 5, `ticks=${statusCount} statusReplies=${(svTail.match(/net address/g) ?? []).length}`);
check("9.5 both clients still appear in the server's status", /Mover/.test(svTail) && /Idler/.test(svTail), svTail.split("\n").filter((l) => /Mover|Idler/.test(l)).slice(-2).join(" | "));
check("9.6 no uncaught engine exceptions during the long run", engineErrors.length === errAtStart, engineErrors.slice(errAtStart).map((e) => e.split("\n")[0]).join(" ;; ").slice(0, 240));
check("9.7 no server-side error text during the long run", !/Host_Error|SV_Error|Sys_Error|Fatal:/.test(svTail), (/(Host_Error|SV_Error|Sys_Error|Fatal:).*/.exec(svTail)?.[0] ?? "").slice(0, 200));

const rssGrowth = (mu.rss - rss0) / 1048576;
const heapGrowth = (mu.heapUsed - heap0) / 1048576;
check("9.8 the mover client's heap is stable (under 64 MB growth over 3 min)", heapGrowth < 64, `heap ${(heap0 / 1048576).toFixed(1)}MB -> ${(mu.heapUsed / 1048576).toFixed(1)}MB (+${heapGrowth.toFixed(1)}MB), rss +${rssGrowth.toFixed(1)}MB`);

const cm = conMark();
const p = await shot("s9_after_long_run");
check("9.9 screenshot after the long run", p !== null, `${p} console="${conSince(cm).join(" | ").slice(0, 120)}"`);

idler.stdin.write("?quit\n");
idler.stdin.flush();
await pump(1500);
try {
  idler.kill(9);
} catch {
  /* gone */
}
sv.kill(9);
await pump(400);
summary("s9");
process.exit(0);
