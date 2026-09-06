// Diagnostic: does a client-issued `serverinfo` round-trip through the
// server's RD_CLIENT redirect and print in the client console?
import { CA_ACTIVE, bootClient, check, cls, conMark, conSince, execPump, pump, pumpUntil, serverReady, startServer, summary } from "./e_lib";

const PORT = 27607;
const sv = startServer("s1c_sv", ["-port", String(PORT), "+map", "dm3"]);
await serverReady(sv);
await bootClient(["+connect", `127.0.0.1:${PORT}`]);
await pumpUntil(() => cls.state === CA_ACTIVE, 25000);
await pump(1500);

sv.send('serverinfo hostname "e2e"');
await pump(1500);

for (const c of ["serverinfo", "users", "user", "version", "pings"]) {
  const m = sv.mark();
  const cm = conMark();
  await execPump(c, 2000);
  console.log(`--- client "${c}" -> client console: ${JSON.stringify(conSince(cm))}`);
  console.log(`--- client "${c}" -> server stdout: ${JSON.stringify(sv.since(m))}`);
}

check("s1c ran", true);
sv.kill(9);
summary("s1c");
process.exit(0);
