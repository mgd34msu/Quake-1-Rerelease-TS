// Scenario 2b: the scenario-2 checks whose first pass was mis-scripted
// (wrong userid, wrong frag index, hudswap under the wrong cl_sbar).
import { CA_ACTIVE, bootClient, check, cl, cls, conMark, conSince, engineErrors, exec, execPump, pump, pumpUntil, serverReady, shot, startServer, summary } from "./e_lib";

const PORT = 27609;
const sv = startServer("s2b_sv", ["-port", String(PORT), "+map", "dm3"]);
check("2b.0 qwsv boots", await serverReady(sv));
sv.send("allow_download 1");
await Bun.sleep(600);

await bootClient(["+connect", `127.0.0.1:${PORT}`]);
check("2b.1 client reaches ca_active", await pumpUntil(() => cls.state === CA_ACTIVE, 25000), `cls.state=${cls.state}`);
await pump(1500);

async function svc(line: string, ms = 900): Promise<string> {
  const m = sv.mark();
  sv.send(line);
  await pump(ms);
  return sv.since(m);
}

// The userid the server assigned this connection.
const statusText = await svc("status", 1500);
const uid = /^\s*-?\d+\s+(\d+)\s/m.exec(statusText.split("qport")[1] ?? statusText)?.[1] ?? "1";
console.log("[userid]", uid, "from:", statusText.replace(/\n/g, " | ").slice(0, 200));

await execPump("name Bob", 1500);
await execPump("team red", 800);
await execPump("topcolor 4", 600);
await execPump("bottomcolor 12", 800);
await execPump("setinfo foo bar", 800);
await execPump("msg 3", 800);
await execPump("noaim 1", 1500);

{
  const t = await svc(`user ${uid}`, 1500);
  check("2b.2 team red in the server userinfo", /team\s+red/.test(t), t.replace(/\n/g, " | ").slice(0, 300));
  check("2b.3 topcolor 4 / bottomcolor 12 in the server userinfo", /topcolor\s+4/.test(t) && /bottomcolor\s+12/.test(t), t.replace(/\n/g, " | ").slice(0, 300));
  check("2b.4 setinfo foo bar in the server userinfo", /foo\s+bar/.test(t), t.replace(/\n/g, " | ").slice(0, 300));
  check("2b.5 msg 3 in the server userinfo", /msg\s+3/.test(t), t.replace(/\n/g, " | ").slice(0, 300));
  check("2b.6 noaim 1 in the server userinfo", /noaim\s+1/.test(t), t.replace(/\n/g, " | ").slice(0, 300));
}
{
  await execPump("color 2 3", 1500);
  const t = await svc(`user ${uid}`, 1500);
  check("2b.7 `color 2 3` sets both colors", /topcolor\s+2/.test(t) && /bottomcolor\s+3/.test(t), t.replace(/\n/g, " | ").slice(0, 300));
}
{
  const cm = conMark();
  await execPump("fullinfo", 900);
  check("2b.8 `fullinfo` with no args prints its usage line", conSince(cm).some((l) => l.includes("fullinfo <complete info string>")), conSince(cm).join(" | ").slice(0, 160));
}

// ---- kill / frags ---------------------------------------------------------
function findPlayer(name: string): { slot: number; frags: number } | null {
  for (let i = 0; i < cl.qw.players.length; i++) {
    if (cl.qw.players[i].name === name) return { slot: i, frags: cl.qw.players[i].frags };
  }
  return null;
}
{
  const before = findPlayer("Bob");
  const cm = conMark();
  await execPump("kill", 3500);
  const after = findPlayer("Bob");
  check("2b.9 `kill` decrements this player's frag count", before !== null && after !== null && after.frags < before.frags, `slot=${after?.slot} frags ${before?.frags} -> ${after?.frags} playernum=${cl.qw.playernum} client="${conSince(cm).join(" | ").slice(0, 140)}"`);
}

// ---- download -------------------------------------------------------------
{
  const cm = conMark();
  await execPump("download maps/dm2.bsp", 6000);
  const seen = conSince(cm);
  check("2b.10 `download maps/dm2.bsp` answers and does not wedge", seen.length > 0 && cls.state === CA_ACTIVE && engineErrors.length === 0, `client=${JSON.stringify(seen.slice(0, 6))}`);
  await execPump("stopul", 500);
  await pump(2000);
}

// ---- hud layout screenshots ----------------------------------------------
{
  await execPump("cl_sbar 0", 600);
  await execPump("cl_hudswap 0", 900);
  const a = await shot("s2b_hud_right");
  await execPump("cl_hudswap 1", 900);
  const b = await shot("s2b_hud_left");
  await execPump("cl_sbar 1", 900);
  const c = await shot("s2b_sbar_full");
  check("2b.11 three hud-layout screenshots written", a !== null && b !== null && c !== null, `${a} ${b} ${c}`);
}

// ---- spectator-free scoreboard shot with a real frag count ---------------
{
  exec("+showscores");
  await pump(900);
  const p = await shot("s2b_scores");
  exec("-showscores");
  await pump(400);
  check("2b.12 scoreboard screenshot written", p !== null, String(p));
}

check("2b.13 no uncaught engine exceptions", engineErrors.length === 0, engineErrors.map((e) => e.split("\n")[0]).join(" ;; ").slice(0, 240));
sv.kill(9);
await pump(400);
summary("s2b");
process.exit(0);
