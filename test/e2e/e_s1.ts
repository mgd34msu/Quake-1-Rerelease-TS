// Scenario 1: qwsv console commands typed on the server's stdin, observed on
// both sides with one qwcl connected. One line per server frame -- two lines
// in a single read get glued together (see E.md, SV_GetConsoleCommands).
import { BASEDIR, CA_ACTIVE, REPO, bootClient, check, cl, cls, conMark, conSince, conTail, engineErrors, execPump, pump, pumpUntil, serverReady, startServer, summary } from "./e_lib";
import { existsSync, readdirSync, rmSync } from "node:fs";

const PORT = 27606;
rmSync(`${REPO}/qw/snap`, { recursive: true, force: true });
for (const f of readdirSync(`${BASEDIR}/qw`)) {
  if (/^(qconsole\.log|frag_\d+\.log)$/.test(f)) rmSync(`${BASEDIR}/qw/${f}`, { force: true });
}

const sv = startServer("s1_sv", ["-port", String(PORT), "+map", "dm3"]);
check("1.0 qwsv boots and opens its socket", await serverReady(sv));

await bootClient(["+connect", `127.0.0.1:${PORT}`]);
check("1.0b qwcl reaches ca_active on dm3", await pumpUntil(() => cls.state === CA_ACTIVE, 25000), `cls.state=${cls.state} levelname="${cl.levelname}"`);
await pump(1200);

/** Send one console line and step the client while the server digests it. */
async function svc(line: string, ms = 700): Promise<void> {
  sv.send(line);
  await pump(ms);
}

// ---- status ---------------------------------------------------------------
{
  const m = sv.mark();
  await svc("status", 1200);
  const t = sv.since(m);
  check("1.1 status lists the connected client", /unnamed/.test(t) && /net address/.test(t) && /qport/.test(t), t.split("\n").filter((l) => l.trim()).slice(-1)[0] ?? "");
}

// ---- serverinfo -----------------------------------------------------------
{
  const m = sv.mark();
  await svc("serverinfo", 1200);
  const t = sv.since(m);
  check("1.2 serverinfo dumps the server info string", t.includes("Server info settings") && t.includes("maxclients"), (t.split("\n").find((l) => l.includes("hostname")) ?? "").trim());
}
{
  await svc('serverinfo hostname "e2e"', 1500);
  const cm = conMark();
  await execPump("serverinfo", 1200);
  const seen = conSince(cm);
  check("1.3a client `serverinfo` prints something", seen.length > 0, `lines=${JSON.stringify(seen.slice(0, 4))}`);
  check("1.3b client's serverinfo carries hostname e2e", seen.some((l) => l.includes("e2e")), seen.join(" | ").slice(0, 300));
}

// ---- localinfo ------------------------------------------------------------
{
  await svc("localinfo e2ekey e2eval", 700);
  const m = sv.mark();
  await svc("localinfo", 900);
  const t = sv.since(m);
  check("1.4 localinfo sets and lists a key", t.includes("e2ekey") && t.includes("e2eval"), t.replace(/\n/g, " | ").slice(0, 200));
}

// ---- say ------------------------------------------------------------------
{
  const cm = conMark();
  await svc("say hi", 1500);
  const seen = conSince(cm).join(" | ");
  check("1.5 server `say hi` prints on the client as console: hi", /console:\s*hi/.test(seen), seen.slice(0, 200));
}

// ---- user <id> ------------------------------------------------------------
{
  const m = sv.mark();
  await svc("user 1", 1000);
  const t = sv.since(m);
  check("1.6 `user 1` dumps that client's userinfo", /name|msg|rate/.test(t) && !/Couldn't find/.test(t), t.replace(/\n/g, " | ").slice(0, 220));
}

// ---- floodprot ------------------------------------------------------------
{
  const m = sv.mark();
  await svc("floodprot 3 1 5", 700);
  await svc('floodprotmsg "slow down"', 700);
  await svc("floodprot", 900);
  await svc("floodprotmsg", 900);
  const t = sv.since(m);
  check("1.7a floodprot 3 1 5 takes effect (server readback)", /After 3 msgs per 1 seconds, silence for 5 seconds/.test(t), t.replace(/\n/g, " | ").slice(0, 220));
  check("1.7b floodprotmsg takes effect (server readback)", /Current msg: slow down/.test(t), t.replace(/\n/g, " | ").slice(0, 220));

  const cm = conMark();
  for (let i = 0; i < 8; i++) await execPump(`say spam${i}`, 90);
  await pump(1800);
  const seen = conSince(cm).join(" | ");
  check("1.7c a spamming client gets the custom floodprot message", /FloodProt: slow down/.test(seen), seen.slice(-280));
  await pump(6000); // let the silence expire
}

// ---- snap <userid> --------------------------------------------------------
{
  const m = sv.mark();
  await svc("snap 1", 7000);
  const t = sv.since(m);
  // gamedirfile is the bare gamedir name in QW, so snaps land under CWD/qw/snap
  const dir = `${REPO}/qw/snap`;
  const files = existsSync(dir) ? readdirSync(dir) : [];
  check("1.8 snap <userid> pulls a remote screenshot from the client", /upload completed/.test(t) && files.length > 0, `server="${t.replace(/\n/g, " | ").slice(0, 160)}" files=${JSON.stringify(files)}`);
}

// ---- gamedir --------------------------------------------------------------
{
  const m = sv.mark();
  await svc("gamedir qw", 1200);
  const t = sv.since(m);
  check("1.9 gamedir qw is accepted", !/Error|error/.test(t) && sv.proc.exitCode === null, t.replace(/\n/g, " | ").slice(0, 200));
}

// ---- logfile / fraglogfile ------------------------------------------------
{
  await svc("logfile", 900);
  await svc("fraglogfile", 900);
  await svc("say logged line", 1200);
  await svc("logfile", 900); // close so the bytes are flushed
  const dirFiles = readdirSync(`${BASEDIR}/qw`);
  check("1.10 logfile writes <gamedir>/qconsole.log", dirFiles.includes("qconsole.log"), JSON.stringify(dirFiles));
  check("1.11 fraglogfile writes <gamedir>/frag_N.log", dirFiles.some((f) => /^frag_\d+\.log$/.test(f)), JSON.stringify(dirFiles));
}

// ---- map dm2 with a client attached ---------------------------------------
{
  const cm = conMark();
  await svc("map dm2", 500);
  const followed = await pumpUntil(() => cls.state === CA_ACTIVE && cl.levelname.includes("Claustrophobopolis"), 30000);
  check("1.12 client follows `map dm2` into the new level", followed, `cls.state=${cls.state} levelname="${cl.levelname}"`);
  const seen = conSince(cm).join(" | ");
  check("1.12b client ran the reconnect flow on the map change", /Connected|Claustro/i.test(seen), seen.slice(0, 260));
  await pump(1500);
  const sm = conMark();
  await execPump("screenshot", 1800);
  check("1.12c screenshot taken on dm2", conSince(sm).some((l) => l.includes("Wrote")), conTail(2));
}

// ---- kick -----------------------------------------------------------------
{
  const cm = conMark();
  const m = sv.mark();
  await svc("kick 1", 500);
  const dropped = await pumpUntil(() => cls.state !== CA_ACTIVE, 10000);
  check("1.13 kick <userid> drops the client", dropped, `cls.state=${cls.state} server="${sv.since(m).replace(/\n/g, " | ").slice(0, 180)}" client="${conSince(cm).join(" | ").slice(-160)}"`);
  await pump(600);
}
{
  const m = sv.mark();
  await svc("kick unnamed", 900);
  const t = sv.since(m);
  // QW 2.33's SV_Kick_f is atoi(Cmd_Argv(1)) only -- names are not accepted.
  check("1.14 kick <name> is rejected (QW 2.33 takes a userid only)", /Couldn't find user number/.test(t), t.replace(/\n/g, " | ").slice(0, 160));
}

// ---- addip / listip / removeip --------------------------------------------
{
  const m = sv.mark();
  await svc("addip 127.0.0.1", 800);
  await svc("listip", 1200);
  const t = sv.since(m);
  check("1.15 listip shows the added address", /Filter list/.test(t) && /127\.\s*0\.\s*0\.\s*1/.test(t), t.replace(/\n/g, " | ").slice(0, 200));

  const cm = conMark();
  await execPump(`connect 127.0.0.1:${PORT}`, 800);
  const gotIn = await pumpUntil(() => cls.state === CA_ACTIVE, 9000);
  const seen = conSince(cm).join(" | ");
  check("1.16 a banned address is refused with the ban message", !gotIn && /banned/i.test(seen), `reached_active=${gotIn} client="${seen.slice(0, 250)}"`);
  await execPump("disconnect", 700);

  await svc("removeip 127.0.0.1", 1000);
  await execPump(`connect 127.0.0.1:${PORT}`, 800);
  const back = await pumpUntil(() => cls.state === CA_ACTIVE, 25000);
  check("1.17 removeip lets the address connect again", back, `cls.state=${cls.state}`);
}

// ---- setmaster / heartbeat (kills the server if a send throws) ------------
{
  const m = sv.mark();
  await svc("setmaster none", 900);
  check("1.18 setmaster none is accepted", sv.proc.exitCode === null, sv.since(m).replace(/\n/g, " | ").slice(0, 160));
}
{
  const m = sv.mark();
  await svc("setmaster 127.0.0.1:27000", 900);
  await svc("heartbeat", 3000);
  const t = sv.since(m);
  check("1.19 heartbeat to a non-existent master does not kill the server", sv.proc.exitCode === null, `exitCode=${sv.proc.exitCode} server="${t.replace(/\n/g, " | ").slice(0, 250)}"`);
}

// ---- quit -----------------------------------------------------------------
{
  const alive = sv.proc.exitCode === null;
  const before = engineErrors.length;
  const cm = conMark();
  if (alive) await svc("quit", 500);
  await pump(5000);
  const seen = conSince(cm).join(" | ");
  check("1.20 server quit tells the connected client", !alive || /server shutdown|Server disconnected/i.test(seen), seen.slice(0, 250));
  check("1.21 the client survives the server going away", engineErrors.length === before, engineErrors.length > before ? engineErrors[before].split("\n").slice(0, 5).join(" / ") : "");
}

sv.kill();
summary("s1");
process.exit(0);
