// Secondary qwcl process, driven over stdin so a scenario script can run two
// real clients. QW 2.33's client has no -port (NET_Init(PORT_CLIENT) is
// hard-coded to 27001), so the second instance is separated with -ip.
//
// stdin protocol, one per line:
//   @<ms>       pump the client for <ms> milliseconds
//   ?state      print [c2state] <cls.state>
//   ?players    print [c2players] <json>
//   ?con        print [c2con] <json of the last 12 console lines>
//   anything else -> a console command
import { CA_ACTIVE, bootClient, cl, cls, conLines, engineErrors, exec, pump } from "./e_lib";

const args = process.argv.slice(2);
await bootClient(args);
console.log("[c2] booted");

const lines: string[] = [];
let buf = "";
const dec = new TextDecoder();
void (async () => {
  for await (const chunk of Bun.stdin.stream()) {
    buf += dec.decode(chunk);
    let i = buf.indexOf("\n");
    while (i !== -1) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
    }
  }
})();

let quit = false;
while (!quit) {
  const line = lines.shift();
  if (line === undefined) {
    await pump(60);
    continue;
  }
  const s = line.trim();
  if (s === "") continue;
  if (s === "?quit") {
    quit = true;
  } else if (s.startsWith("@")) {
    await pump(Number(s.slice(1)) || 100);
  } else if (s === "?state") {
    console.log(`[c2state] ${cls.state} active=${cls.state === CA_ACTIVE}`);
  } else if (s === "?players") {
    console.log(`[c2players] ${JSON.stringify(cl.qw.players.filter((p) => p.name !== "").map((p) => ({ name: p.name, frags: p.frags, spectator: p.spectator })))}`);
  } else if (s === "?con") {
    console.log(`[c2con] ${JSON.stringify(conLines().filter((l) => l.length).slice(-12))}`);
  } else if (s === "?errors") {
    console.log(`[c2errors] ${engineErrors.length}`);
  } else {
    exec(s);
    await pump(400);
  }
}
console.log("[c2] done");
process.exit(0);
