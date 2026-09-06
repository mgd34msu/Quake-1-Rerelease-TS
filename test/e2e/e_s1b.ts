// Scenario 1b: focused diagnostics for floodprot/floodprotmsg, client-side
// serverinfo propagation, map change, kick, addip/listip/removeip, quit.
// Split out of e_s1.ts because `heartbeat` to a dead master kills the server.
import { BASEDIR, CA_ACTIVE, bootClient, check, cl, cls, conMark, conSince, conTail, engineErrors, execPump, pump, pumpUntil, serverReady, startServer, summary } from "./e_lib";

const PORT = 27604;
const sv = startServer("s1b_sv", ["-port", String(PORT), "+map", "dm3"]);
check("1b.0 server boots", await serverReady(sv));

// Does the server accept two console lines written back-to-back?
{
  const m = sv.mark();
  sv.send("floodprot 3 1 5");
  sv.send('floodprotmsg "slow down"');
  await Bun.sleep(1500);
  sv.send("floodprot");
  sv.send("floodprotmsg");
  await Bun.sleep(1500);
  const t = sv.since(m);
  check("1b.1 floodprot readback shows 3/1/5", /After 3 msgs per 1 seconds, silence for 5 seconds/.test(t), t.replace(/\n/g, " | ").slice(0, 250));
  check("1b.2 floodprotmsg readback shows the custom msg", /Current msg: slow down/.test(t), t.replace(/\n/g, " | ").slice(0, 250));
}

await bootClient(["+connect", `127.0.0.1:${PORT}`]);
check("1b.3 client reaches ca_active", await pumpUntil(() => cls.state === CA_ACTIVE, 25000), `cls.state=${cls.state}`);
await pump(1200);

// ---- floodprot in effect --------------------------------------------------
{
  const cm = conMark();
  for (let i = 0; i < 8; i++) await execPump(`say spam${i}`, 80);
  await pump(1500);
  const seen = conSince(cm).join(" | ");
  check("1b.4 the custom floodprot message is what the flooder gets", /FloodProt: slow down/.test(seen), seen.slice(-260));
  check("1b.5 silence length is the configured 5 seconds", /can't talk for [1-5] more seconds|talk for 5 seconds/.test(seen), seen.slice(-260));
  await pump(6000); // let the lock expire
}

// ---- serverinfo to the client --------------------------------------------
{
  sv.send('serverinfo hostname "e2e"');
  await pump(2000);
  const cm = conMark();
  await execPump("serverinfo", 1200);
  const seen = conSince(cm);
  check("1b.6 client `serverinfo` prints the server's info string", seen.length > 0, `lines=${JSON.stringify(seen.slice(0, 6))}`);
  check("1b.7 client sees hostname e2e", seen.some((l) => l.includes("e2e")), seen.join(" | ").slice(0, 300));
}

// ---- map change ----------------------------------------------------------
{
  const cm = conMark();
  sv.send("map dm2");
  const followed = await pumpUntil(() => cls.state === CA_ACTIVE && cl.levelname.includes("Claustrophobopolis"), 30000);
  check("1b.8 client follows `map dm2`", followed, `cls.state=${cls.state} levelname="${cl.levelname}"`);
  const seen = conSince(cm).join(" | ");
  check("1b.9 client ran the changing/reconnect flow", /Connected|Claustro/i.test(seen), seen.slice(0, 300));
  await pump(1500);
  const sm = conMark();
  await execPump("screenshot", 1800);
  check("1b.10 screenshot written on dm2", conSince(sm).some((l) => l.includes("Wrote")), conTail(2));
}

// ---- kick ----------------------------------------------------------------
{
  const m = sv.mark();
  sv.send("kick 1");
  const dropped = await pumpUntil(() => cls.state !== CA_ACTIVE, 10000);
  check("1b.11 kick <userid> drops the client", dropped, `cls.state=${cls.state} server="${sv.since(m).replace(/\n/g, " | ").slice(0, 200)}"`);
  await pump(500);
}
{
  await execPump(`connect 127.0.0.1:${PORT}`, 600);
  const back = await pumpUntil(() => cls.state === CA_ACTIVE, 25000);
  check("1b.12 client reconnects after a kick", back, `cls.state=${cls.state}`);
  if (back) {
    const m = sv.mark();
    sv.send("kick unnamed");
    const dropped = await pumpUntil(() => cls.state !== CA_ACTIVE, 10000);
    check("1b.13 kick <name> drops the client", dropped, `cls.state=${cls.state} server="${sv.since(m).replace(/\n/g, " | ").slice(0, 200)}"`);
  }
}

// ---- addip / listip / removeip -------------------------------------------
{
  const m = sv.mark();
  sv.send("addip 127.0.0.1");
  await pump(800);
  sv.send("listip");
  await pump(1200);
  const t = sv.since(m);
  check("1b.14 listip shows the added address", /127\.0\.0\.1/.test(t), t.replace(/\n/g, " | ").slice(0, 250));

  const cm = conMark();
  await execPump(`connect 127.0.0.1:${PORT}`, 600);
  const gotIn = await pumpUntil(() => cls.state === CA_ACTIVE, 8000);
  const seen = conSince(cm).join(" | ");
  check("1b.15 a banned address is refused with the ban message", !gotIn && /banned/i.test(seen), `active=${gotIn} client="${seen.slice(0, 250)}"`);
  await execPump("disconnect", 500);

  sv.send("removeip 127.0.0.1");
  await pump(1000);
  await execPump(`connect 127.0.0.1:${PORT}`, 600);
  const back = await pumpUntil(() => cls.state === CA_ACTIVE, 25000);
  check("1b.16 removeip lets the address connect again", back, `cls.state=${cls.state}`);
}

// ---- quit ----------------------------------------------------------------
{
  const before = engineErrors.length;
  const cm = conMark();
  sv.send("quit");
  await pump(5000);
  const seen = conSince(cm).join(" | ");
  check("1b.17 server quit tells the client", /server shutdown|Server disconnected/i.test(seen), seen.slice(0, 250));
  check("1b.18 client survives the server going away", engineErrors.length === before, engineErrors.length > before ? engineErrors[before].split("\n").slice(0, 5).join(" / ") : "");
}

sv.kill();
summary("s1b");
console.log("basedir:", BASEDIR);
process.exit(0);
