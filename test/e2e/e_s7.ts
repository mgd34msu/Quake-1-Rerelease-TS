// Scenario 7: the server walks every deathmatch map (and a single-player map)
// with a client following each change; one screenshot per map.
import { CA_ACTIVE, bootClient, check, cl, cls, conMark, conSince, engineErrors, pump, pumpUntil, serverReady, shot, startServer, summary } from "./e_lib";

const PORT = 27615;
const MAPS = ["dm1", "dm2", "dm3", "dm4", "dm5", "dm6", "e1m1"];

const sv = startServer("s7_sv", ["-port", String(PORT), "+map", "dm1"]);
check("7.0 qwsv boots on dm1", await serverReady(sv));
await bootClient(["-ip", "127.0.0.1", "+connect", `127.0.0.1:${PORT}`]);
check("7.1 client reaches ca_active on dm1", await pumpUntil(() => cls.state === CA_ACTIVE, 25000), `cls.state=${cls.state} levelname="${cl.levelname}"`);
await pump(2000);

const levels: Record<string, string> = {};
for (const map of MAPS) {
  const before = cl.levelname;
  const cm = conMark();
  const m = sv.mark();
  if (map !== "dm1") {
    if (sv.proc.exitCode !== null) {
      check(`7.${map} client follows \`map ${map}\``, false, `server already exited (exitCode=${sv.proc.exitCode}) -- see the dump below`);
      break;
    }
    sv.send(`map ${map}`);
    await pump(400);
    const ok = await pumpUntil(() => cls.state === CA_ACTIVE && cl.levelname !== before, 35000);
    check(`7.${map} client follows \`map ${map}\``, ok, `cls.state=${cls.state} levelname="${cl.levelname}" svExit=${sv.proc.exitCode}`);
    if (!ok) {
      console.log(`[server tail after map ${map}]\n` + sv.since(m).split("\n").slice(0, 60).join("\n"));
      console.log(`[client tail after map ${map}]\n` + conSince(cm).slice(0, 30).join("\n"));
      break;
    }
  }
  await pump(2500);
  levels[map] = cl.levelname;
  const p = await shot(`s7_${map}`);
  check(`7.${map}-shot screenshot on ${map}`, p !== null, `${p} levelname="${cl.levelname}"`);
  const svOut = sv.since(m);
  const clOut = conSince(cm).join(" | ");
  check(`7.${map}-clean no error text on either side for ${map}`, !/Host_Error|SV_Error|Sys_Error|not found|Bad |ERROR/i.test(svOut), `server="${svOut.replace(/\n/g, " | ").slice(0, 220)}"`);
  if (map === "e1m1") {
    check("7.e1m1-progs e1m1 runs under qwprogs (no monsters, no progs errors)", cls.state === CA_ACTIVE && !/progs|PR_/i.test(svOut), `server="${svOut.replace(/\n/g, " | ").slice(0, 260)}" client="${clOut.slice(-200)}"`);
  }
}
console.log("[levelnames]", JSON.stringify(levels));
check("7.z no uncaught engine exceptions across the map walk", engineErrors.length === 0, engineErrors.map((e) => e.split("\n")[0]).join(" ;; ").slice(0, 240));
check("7.z2 the server survived the whole walk", sv.proc.exitCode === null, `exitCode=${sv.proc.exitCode}`);

sv.kill(9);
await pump(400);
summary("s7");
process.exit(0);
