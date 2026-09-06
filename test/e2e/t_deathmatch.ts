/*
t_deathmatch -- two clients, one dedicated server, one match.

  bun test/e2e/t_deathmatch.ts --mode dm   --content classic-id1 --map dm4  --protocol 666 --port 26320
  bun test/e2e/t_deathmatch.ts --mode dm   --content ctf         --map ctf1 --protocol 999 --port 26322
  bun test/e2e/t_deathmatch.ts --mode coop --content classic-id1 --map e1m1 --protocol 666 --port 26324

Three OS processes, all of them the compiled binary, on real UDP. In `dm` both
clients enter the same deathmatch, each one asks the server for the scoreboard
(a client's `status` is forwarded to the server, which answers over the wire
with the full player list and their frags -- the scoreboard as that client
received it), one of them dies, and the driver checks that the frag reached
BOTH clients' scoreboards and the server's own `status`. In `coop` both
players spawn into the single-player map and the driver checks they were sent
the same monsters.

Both clients are POLLED clients (t_lib's startPolledClient), so the driver
sequences the match itself -- attack, then die, then read the scoreboard --
instead of hoping two independently-started fixed timelines stay lined up.

The kill is a `kill` from the victim rather than a hit from the attacker's
shots: two headless clients have no way to aim at each other, and the brief
allows either. The attacker still runs an attack loop over the map first, and
the driver reports whether it scored.
*/

import {
  argValue,
  baseArgs,
  check,
  contentById,
  killSeat,
  parseEdicts,
  readLog,
  serverProtocolLine,
  serverRuleset,
  sleep,
  startPolledClient,
  startServer,
  summary,
  svQuery,
  waitFor,
} from "./t_lib";

/*
KNOWN BLOCKER on a single host: two NetQuake clients from the SAME IP address
cannot both hold a slot on one server. net_dgrm.ts's
_Datagram_CheckNewConnections walks the active sockets and treats
`AddrCompare(clientaddr, s.addr) >= 0` as "somebody coming back in from a
crash/disconnect", closing the incumbent -- and net_udp.ts's UDP_AddrCompare
returns 1 (not -1) when the ADDRESS matches and only the PORT differs, which
is exactly two clients on 127.0.0.1. UDP_OpenSocket binds INADDR_ANY, and
`-ip` only changes the address the engine reports for itself, so the two
clients cannot be given distinct source addresses either. The server log shows
"NET_GetMessage: disconnected socket / SV_ReadClientMessage: NET_GetMessage
failed / Client <first> removed" immediately before the second player enters.
The assertions below are the behaviour the charter asks for and stay red until
that comparison stops matching two different clients; see this unit's report.
*/

const mode = argValue("mode", "dm");
const contentId = argValue("content", "classic-id1");
const protocolArg = argValue("protocol", "666");
const port = argValue("port", "26320");
const c = contentById(contentId);
const map = argValue("map", mode === "coop" ? c.map : c.dmMap);

const slug = `${mode}_${contentId}_${map}_${protocolArg}`.replace(/[^A-Za-z0-9_]/g, "_");
const NAME_A = "TFRAGA";
const NAME_B = "TFRAGB";

console.log(`t_deathmatch: mode=${mode} content=${contentId} map=${map} protocol=${protocolArg} port=${port}`);

const serverArgs = [
  ...baseArgs(c, `e2e_t_${slug}_sv`),
  "-port", port,
  "+sv_cheats", "1",
  ...(mode === "coop" ? ["+coop", "1", "+deathmatch", "0"] : ["+coop", "0", "+deathmatch", "1"]),
  "+sv_protocol", protocolArg,
  "+map", map,
];

const sv = startServer(`t_dm_${slug}_sv`, serverArgs);
const booted = await waitFor(sv, /Server protocol \d+ \(flags/, 90000);
check("server boots the match map", booted, booted ? "" : `no "Server protocol" line in ${sv.log}`);
if (!booted) summary(`t_deathmatch ${slug}`);

const svProto = serverProtocolLine(readLog(sv));
check(
  "server serves the requested protocol",
  svProto !== null && svProto.protocol === Number(protocolArg),
  `asked for ${protocolArg}, got ${svProto === null ? "nothing" : svProto.protocol}`,
);
check("server ruleset matches the content tree", serverRuleset(readLog(sv)) === c.ruleset, `expected ${c.ruleset}, got ${serverRuleset(readLog(sv)) ?? "nothing"}`);

/*
The two clients are started one at a time, not together. Two NetQuake clients
whose CCREQ_CONNECT lands on the server in the same instant do not both make
it through the signon here -- the first is dropped with "NET_GetMessage:
disconnected socket / SV_ReadClientMessage: NET_GetMessage failed / Client
unconnected removed" while the second joins normally (see this unit's report).
Staggering them is a harness workaround, not a claim that simultaneous
connects are supposed to fail.
*/
const clA = startPolledClient(`t_dm_${slug}_a`, `e2e_t_${slug}_a`, [...baseArgs(c, `e2e_t_${slug}_a`), "-port", port], [
  "cl_shownet 0",
  "disconnect",
  `name ${NAME_A}`,
  "connect 127.0.0.1",
]);
const inA = await waitFor(sv, new RegExp(`${NAME_A} entered the game`), 120000);
// Armed as soon as THIS client is in: the boot cfg's arming window is only a
// few seconds wide (it has to fit the command buffer), so a seat cannot wait
// for the other one to join before it is armed.
await clA.arm();

const clB = startPolledClient(`t_dm_${slug}_b`, `e2e_t_${slug}_b`, [...baseArgs(c, `e2e_t_${slug}_b`), "-port", port], [
  "cl_shownet 0",
  "disconnect",
  `name ${NAME_B}`,
  "connect 127.0.0.1",
]);
const inB = await waitFor(sv, new RegExp(`${NAME_B} entered the game`), 120000);
await clB.arm();

check("both clients enter the game", inA && inB, `${NAME_A}=${inA} ${NAME_B}=${inB}; ${(readLog(sv).match(/.*entered the game.*/g) ?? []).join(" | ")}`);

const status1 = await svQuery(sv, "status", "S1");
check("the server's status lists two active players", /players:\s*2 active/.test(status1), (status1.match(/players:.*/g) ?? []).join(" | "));

// Each client asks the server for the scoreboard; the reply comes back over
// the wire and into that client's own console.
await clA.run(["status"]);
await clB.run(["status"]);
await sleep(1500);
const scoreA1 = readLog(clA.seat);
const scoreB1 = readLog(clB.seat);
check("client A's scoreboard lists both players", scoreA1.includes(NAME_A) && scoreA1.includes(NAME_B), `A sees ${[NAME_A, NAME_B].filter((n) => scoreA1.includes(n)).join("+") || "neither"}`);
check("client B's scoreboard lists both players", scoreB1.includes(NAME_A) && scoreB1.includes(NAME_B), `B sees ${[NAME_A, NAME_B].filter((n) => scoreB1.includes(n)).join("+") || "neither"}`);

if (mode === "coop") {
  const dump = await svQuery(sv, "edicts", "COOP");
  const monsters = [...dump.matchAll(/classname\s+(monster_\w+)/g)].map((m) => m[1]);
  const unique = [...new Set(monsters)];
  check("the coop map spawned monsters", monsters.length > 0, `${monsters.length} monster edicts, ${unique.length} kinds`);

  // Both clients precached the models the server named, so "the same
  // monsters" is the same set of monster models loaded on both sides. The
  // model file's stem is the monster's own name in the classic progs
  // (monster_army -> progs/soldier.mdl is the one exception, so the head
  // model both clients also load is what is compared).
  const logA = readLog(clA.seat);
  const logB = readLog(clB.seat);
  const modelsOf = (text: string): string[] => [...new Set([...text.matchAll(/progs\/([a-z0-9_]+)\.mdl/g)].map((m) => m[1]))].sort();
  const mA = modelsOf(logA);
  const mB = modelsOf(logB);
  const onlyA = mA.filter((m) => !mB.includes(m));
  const onlyB = mB.filter((m) => !mA.includes(m));
  check(
    "both coop clients loaded the same model set",
    mA.length > 0 && onlyA.length === 0 && onlyB.length === 0,
    onlyA.length === 0 && onlyB.length === 0 ? `${mA.length} models on both` : `only A: ${onlyA.join(",")}; only B: ${onlyB.join(",")}`,
  );

  // The monster models are in that shared set: both clients were sent the
  // same monsters, not just the same items.
  const monsterModels = new Set<string>();
  for (const e of parseEdicts(dump)) {
    const cls = e.fields.get("classname") ?? "";
    if (!cls.startsWith("monster_")) continue;
    const model = e.fields.get("model") ?? "";
    const m = /progs\/([a-z0-9_]+)\.mdl/.exec(model);
    if (m !== null) monsterModels.add(m[1]);
  }
  const missing = [...monsterModels].filter((m) => !(mA.includes(m) && mB.includes(m)));
  check(
    "both coop clients loaded every monster model the server spawned",
    monsterModels.size > 0 && missing.length === 0,
    missing.length === 0 ? [...monsterModels].join(", ") : `missing on one side: ${missing.join(", ")}`,
  );

  const statusC = await svQuery(sv, "status", "SC");
  check("both coop players hold a slot on the server", /players:\s*2 active/.test(statusC), (statusC.match(/players:.*/g) ?? []).join(" | "));
} else {
  // The attacker sweeps the map first; two headless clients cannot aim, so
  // whether this scores is reported, not asserted.
  await clA.run(["impulse 2", "+attack", "+right"]);
  await sleep(6000);
  await clA.run(["-attack", "-right"]);

  const statusBefore = await svQuery(sv, "status", "SB");
  const fragOf = (text: string, who: string): number | null => {
    const m = new RegExp(`#\\d+\\s+${who}\\s+(-?\\d+)\\s`).exec(text);
    return m === null ? null : Number(m[1]);
  };

  await clB.run(["kill"]);
  await sleep(3000);

  const statusK = await svQuery(sv, "status", "S2");
  const fragB = fragOf(statusK, NAME_B);
  const fragA = fragOf(statusK, NAME_A);
  check("the server's status shows the victim's frag total went negative", fragB !== null && fragB < 0, `${NAME_B} frags=${fragB ?? "not listed"} (was ${fragOf(statusBefore, NAME_B) ?? "not listed"}), ${NAME_A} frags=${fragA ?? "not listed"}`);

  const deathLine = /suicide|killed himself|blew (him|them)self|bit the dust|died/i;
  const logA = readLog(clA.seat);
  const logB = readLog(clB.seat);
  const obitA = (logA.match(new RegExp(`.*${NAME_B}.*`, "g")) ?? []).filter((l) => deathLine.test(l));
  const obitB = (logB.match(new RegExp(`.*${NAME_B}.*`, "g")) ?? []).filter((l) => deathLine.test(l));
  check("the death is announced on client A", obitA.length > 0, obitA.slice(-1).join("") || "no obituary naming the victim in A's console");
  check("the death is announced on client B", obitB.length > 0, obitB.slice(-1).join("") || "no obituary naming the victim in B's console");

  // The frag reached each client's own scoreboard: ask both again, now that
  // the death has happened, and read the victim's frag column out of the
  // reply the server sent them.
  await clA.run(["status"]);
  await clB.run(["status"]);
  await sleep(2000);
  const clFrag = (text: string): number | null => {
    const all = [...text.matchAll(new RegExp(`#\\d+\\s+${NAME_B}\\s+(-?\\d+)\\s`, "g"))];
    return all.length === 0 ? null : Number(all[all.length - 1][1]);
  };
  check("the frag reached client A's scoreboard", (clFrag(readLog(clA.seat)) ?? 0) < 0, `A's last scoreboard has ${NAME_B} at ${clFrag(readLog(clA.seat)) ?? "no row"}`);
  check("the frag reached client B's scoreboard", (clFrag(readLog(clB.seat)) ?? 0) < 0, `B's last scoreboard has ${NAME_B} at ${clFrag(readLog(clB.seat)) ?? "no row"}`);
  console.log(`t_deathmatch: attacker's own frag total after its attack loop: ${fragA ?? "not listed"}`);
}

check(
  "no seat hit a fatal engine error",
  !/Sys_Error|SysError|Fatal:|Host_Error/.test(readLog(sv) + readLog(clA.seat) + readLog(clB.seat)),
  (readLog(sv) + readLog(clA.seat) + readLog(clB.seat)).match(/.*(Sys_Error|Fatal:|Host_Error).*/g)?.slice(0, 2).join(" | ") ?? "",
);

killSeat(clA.seat);
killSeat(clB.seat);
killSeat(sv);
summary(`t_deathmatch ${slug}`);
