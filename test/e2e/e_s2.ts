// Scenario 2: qwcl console commands and cvars, checked on both sides.
import { CA_ACTIVE, Cvar_VariableString, Cvar_VariableValue, bootClient, check, cl, cls, conMark, conSince, engineErrors, exec, execPump, pump, pumpUntil, serverReady, shot, startServer, summary } from "./e_lib";

const PORT = 27608;
const sv = startServer("s2_sv", ["-port", String(PORT), "+map", "dm3"]);
check("2.0 qwsv boots", await serverReady(sv));
sv.send("rcon_password e2epw");
await Bun.sleep(500);
sv.send("pausable 1");
await Bun.sleep(500);
sv.send("allow_download 1");
await Bun.sleep(500);

async function svc(line: string, ms = 800): Promise<void> {
  sv.send(line);
  await pump(ms);
}
function svStatus(): Promise<string> {
  const m = sv.mark();
  sv.send("status");
  return pump(1500).then(() => sv.since(m));
}

// ---- connect / disconnect / reconnect -------------------------------------
await bootClient([]);
await pump(600);
await execPump(`connect 127.0.0.1:${PORT}`, 600);
check("2.1 connect reaches ca_active", await pumpUntil(() => cls.state === CA_ACTIVE, 25000), `cls.state=${cls.state}`);
await pump(1200);

{
  await execPump("disconnect", 1500);
  check("2.2 disconnect leaves the active state", cls.state !== CA_ACTIVE, `cls.state=${cls.state}`);
  await execPump(`connect 127.0.0.1:${PORT}`, 600);
  await pumpUntil(() => cls.state === CA_ACTIVE, 25000);
  const cm = conMark();
  await execPump("reconnect", 600);
  const back = await pumpUntil(() => cls.state === CA_ACTIVE, 25000);
  check("2.3 reconnect re-enters the game", back, `cls.state=${cls.state} client="${conSince(cm).join(" | ").slice(0, 180)}"`);
  await pump(1200);
}

// ---- name / setinfo -------------------------------------------------------
{
  await execPump("name Bob", 1500);
  const t = await svStatus();
  check("2.4 `name Bob` propagates to the server's status", /Bob/.test(t), (t.split("\n").filter((l) => l.trim()).slice(-1)[0] ?? "").trim());
}
{
  await execPump("team red", 1200);
  const m = sv.mark();
  await svc("user 1", 1200);
  const t = sv.since(m);
  check("2.5 `team red` reaches the server userinfo", /team\s+red/.test(t), t.replace(/\n/g, " | ").slice(0, 220));
}
{
  await execPump("topcolor 4", 800);
  await execPump("bottomcolor 12", 1200);
  const m = sv.mark();
  await svc("user 1", 1200);
  const t = sv.since(m);
  check("2.6 topcolor/bottomcolor reach the server userinfo", /topcolor\s+4/.test(t) && /bottomcolor\s+12/.test(t), t.replace(/\n/g, " | ").slice(0, 240));
}
{
  await execPump("color 2 3", 1200);
  const m = sv.mark();
  await svc("user 1", 1200);
  const t = sv.since(m);
  check("2.7 `color 2 3` sets both colors", /topcolor\s+2/.test(t) && /bottomcolor\s+3/.test(t), t.replace(/\n/g, " | ").slice(0, 240));
}
{
  const cm = conMark();
  await execPump("skin base", 3000);
  const seen = conSince(cm).join(" | ");
  check("2.8 `skin base` fails gracefully with no qw/skins", cls.state === CA_ACTIVE && engineErrors.length === 0, `client="${seen.slice(0, 220)}"`);
}
{
  await execPump("setinfo foo bar", 1200);
  const m = sv.mark();
  await svc("user 1", 1200);
  const t = sv.since(m);
  check("2.9 `setinfo foo bar` reaches the server userinfo", /foo\s+bar/.test(t), t.replace(/\n/g, " | ").slice(0, 240));

  const cm = conMark();
  await execPump("fullinfo", 900);
  check("2.10 `fullinfo` with no args prints a usage line", conSince(cm).some((l) => /usage/i.test(l)), conSince(cm).join(" | ").slice(0, 160));
}

// ---- users / user / version ----------------------------------------------
{
  const cm = conMark();
  await execPump("users", 1500);
  const seen = conSince(cm).join(" | ");
  check("2.11 `users` lists the players", /total users/.test(seen) && /Bob/.test(seen), seen.slice(0, 220));
}
{
  const cm = conMark();
  await execPump("version", 900);
  check("2.12 `version` prints a version line", conSince(cm).some((l) => /Version/i.test(l)), conSince(cm).join(" | ").slice(0, 160));
}

// ---- packet (out-of-band) -------------------------------------------------
{
  const cm = conMark();
  await execPump(`packet 127.0.0.1:${PORT} status`, 2500);
  const seen = conSince(cm).join(" | ");
  check("2.13 `packet <sv> status` prints the out-of-band reply", /print|hostname|maxclients|Bob/.test(seen), seen.slice(0, 260));
}

// ---- rcon -----------------------------------------------------------------
{
  await execPump("rcon_password e2epw", 400);
  const cm = conMark();
  const m = sv.mark();
  await execPump("rcon status", 3000);
  const seen = conSince(cm).join(" | ");
  check("2.14 `rcon status` prints the reply in the client console", /net address|frags|userid/.test(seen), `client="${seen.slice(0, 240)}" server="${sv.since(m).replace(/\n/g, " | ").slice(0, 160)}"`);
}

// ---- say / say_team -------------------------------------------------------
{
  const cm = conMark();
  await execPump("say hello world", 1500);
  await execPump("say_team team msg", 1500);
  const seen = conSince(cm).join(" | ");
  check("2.15 say and say_team echo back to the client", /hello world/.test(seen) && /team msg/.test(seen), seen.slice(0, 240));
}

// ---- kill + scoreboard ----------------------------------------------------
{
  const pn = cl.qw.playernum;
  const before = cl.qw.players[pn]?.frags ?? 0;
  const cm = conMark();
  await execPump("kill", 3000);
  const after = cl.qw.players[pn]?.frags ?? 0;
  check("2.16 `kill` costs a frag", after < before || after === -1, `frags ${before} -> ${after} client="${conSince(cm).join(" | ").slice(0, 160)}"`);
  exec("+showscores");
  await pump(800);
  const p = await shot("s2_showscores");
  exec("-showscores");
  await pump(400);
  check("2.17 +showscores overlay screenshot written", p !== null, String(p));
}

// ---- pause ----------------------------------------------------------------
{
  const cm = conMark();
  await execPump("pause", 1800);
  const seen = conSince(cm).join(" | ");
  const paused = seen.length > 0 || cl.paused;
  check("2.18 `pause` is accepted with pausable 1", paused, `cl.paused=${cl.paused} client="${seen.slice(0, 200)}"`);
  await execPump("pause", 1500); // unpause
}

// ---- download -------------------------------------------------------------
{
  const cm = conMark();
  await execPump("download maps/dm2.bsp", 4000);
  const seen = conSince(cm).join(" | ");
  check("2.19 `download maps/dm2.bsp` gets an answer and does not wedge", seen.length > 0 && engineErrors.length === 0, seen.slice(0, 260));
  await execPump("stopul", 400);
  await pump(1500);
}

// ---- cvars ----------------------------------------------------------------
{
  const before = engineErrors.length;
  await execPump("cl_shownet 1", 800);
  check("2.20 cl_shownet 1 set", Cvar_VariableValue("cl_shownet") === 1, Cvar_VariableString("cl_shownet"));
  await pump(1500);
  await execPump("cl_shownet 0", 500);

  await execPump("cl_predict_players 0", 900);
  await pump(1200);
  await execPump("cl_predict_players 1", 900);
  check("2.21 cl_predict_players toggles without an error", engineErrors.length === before, `errors=${engineErrors.length - before}`);

  await execPump("cl_nodelta 1", 900);
  await pump(2000);
  check("2.22 cl_nodelta 1 keeps the client connected", cls.state === CA_ACTIVE && Cvar_VariableValue("cl_nodelta") === 1, `cls.state=${cls.state}`);
  await execPump("cl_nodelta 0", 500);

  await execPump("cl_maxfps 30", 900);
  check("2.23 cl_maxfps 30 set", Cvar_VariableValue("cl_maxfps") === 30, Cvar_VariableString("cl_maxfps"));
  await pump(1500);
  await execPump("cl_maxfps 0", 400);

  await execPump("cl_timeout 120", 500);
  check("2.24 cl_timeout set", Cvar_VariableValue("cl_timeout") === 120, Cvar_VariableString("cl_timeout"));
}

// ---- hud / sbar screenshots ----------------------------------------------
{
  exec("+showteamscores");
  await pump(900);
  const a = await shot("s2_showteamscores");
  exec("-showteamscores");
  await pump(400);
  check("2.25 +showteamscores overlay screenshot written", a !== null, String(a));

  await execPump("cl_sbar 1", 900);
  const b = await shot("s2_sbar1");
  check("2.26 cl_sbar 1 screenshot written", b !== null, String(b));
  await execPump("cl_hudswap 1", 900);
  const c = await shot("s2_hudswap1");
  check("2.27 cl_hudswap 1 screenshot written", c !== null, String(c));
  await execPump("cl_sbar 0", 400);
  await execPump("cl_hudswap 0", 400);
}

// ---- rate / msg / noaim ---------------------------------------------------
{
  await execPump("rate 2500", 1500);
  const t1 = await svStatus();
  await execPump("rate 25000", 1500);
  const t2 = await svStatus();
  const r1 = /Bob\s+(\d+)/.exec(t1)?.[1] ?? "?";
  const r2 = /Bob\s+(\d+)/.exec(t2)?.[1] ?? "?";
  check("2.28 rate changes are visible in the server's status", r1 !== r2, `rate column: ${r1} -> ${r2}`);
}
{
  await execPump("msg 3", 1200);
  const m = sv.mark();
  await svc("user 1", 1200);
  check("2.29 `msg 3` reaches the server userinfo", /msg\s+3/.test(sv.since(m)), sv.since(m).replace(/\n/g, " | ").slice(0, 200));
}
{
  await execPump("noaim 1", 1200);
  const m = sv.mark();
  await svc("user 1", 1200);
  check("2.30 `noaim 1` reaches the server userinfo", /noaim\s+1/.test(sv.since(m)), sv.since(m).replace(/\n/g, " | ").slice(0, 200));
}

check("2.31 no uncaught engine exceptions during scenario 2", engineErrors.length === 0, engineErrors.map((e) => e.split("\n")[0]).join(" ;; ").slice(0, 300));

sv.kill(9);
await pump(500);
summary("s2");
process.exit(0);
