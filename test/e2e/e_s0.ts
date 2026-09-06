// E2E smoke: qwsv boots, qwcl connects and reaches ca_active, screenshot.
import { BASEDIR, CA_ACTIVE, bootClient, check, cl, cls, conTail, execPump, pump, pumpUntil, serverReady, startServer, summary } from "./e_lib";

const PORT = 27602;
const sv = startServer("s0_sv", ["-port", String(PORT), "+map", "dm3"]);
check("server reaches UDP Initialized", await serverReady(sv), "");

await bootClient([`+connect`, `127.0.0.1:${PORT}`]);
const active = await pumpUntil(() => cls.state === CA_ACTIVE, 25000);
check("client reaches ca_active", active, `cls.state=${cls.state}`);
console.log("[client console tail]\n" + conTail(20));

await pump(1500);
console.log("simorg", Array.from(cl.qw.simorg));

const m = sv.mark();
sv.send("status");
await sv.waitFor("frags", 4000);
await pump(300);
console.log("[server status]\n" + sv.since(m));

await execPump("screenshot", 1500);
console.log("[after screenshot]\n" + conTail(4));

sv.send("quit");
await pump(1500);
sv.kill();
summary("s0");
console.log("BASEDIR", BASEDIR);
process.exit(0);
