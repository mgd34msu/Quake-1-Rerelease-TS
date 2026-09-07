/*
t_cross -- the mixed pairings that have to interoperate.

  bun test/e2e/t_cross.ts --port 26360

Four scenarios, run one after another (the last one brings a QuakeWorld client
half up, so this driver takes the runner's `qwclient` lock):

  1. a CLASSIC-content client against a RE-RELEASE server. The two processes
     have different game data mounted -- the client boots `-norerelease`, the
     server boots the 2021 tree -- and the server's progs are the ones in
     force: it announces `Server ruleset rerelease` while the client is still
     reading the classic paks, and the client plays anyway.
  2. a client forced to NetQuake (`cl_protocol 666`) against a server on
     `sv_protocol auto` on a small map: auto answers 666 and the two agree.
  3. three clients at once on protocol 999 with `max_edicts` raised: all three
     hold a slot, and the raised cvar is the one the server is running with.
  4. `cl_protocol` forcing the connect rule both ways
     (src/common/profile.ts's connectProfileFor):
       - `cl_protocol nq` + an address WITH a port must still take the
         NetQuake path, which the bare port suffix would otherwise send to
         QuakeWorld -- asserted by completing a real NetQuake connection;
       - `cl_protocol qw` + an address with NO port must take the QuakeWorld
         handshake, which a bare address would otherwise send to NetQuake --
         asserted by the handshake line the client prints. No QuakeWorld
         server is stood up for this one: the default QuakeWorld server port
         (27500) is outside this unit's assigned 26300-26399 band, and the
         claim under test is which path the client takes, not who answers.
*/

import {
  argValue,
  baseArgs,
  check,
  contentById,
  echoMarker,
  killSeat,
  marker,
  readDemoServerInfo,
  readLog,
  recordedDemoPath,
  serverProtocolLine,
  serverRuleset,
  sleep,
  startClient,
  startServer,
  summary,
  svQuery,
  waits,
  waitFor,
  type SeatT,
} from "./t_lib";

/*
Same-address clients: until F19 (2026-09-06) two NetQuake clients from the
SAME IP address could not both hold a slot -- _Datagram_CheckNewConnections
treated a same-host/different-port request as the first player coming back
from a crash and closed the incumbent. A second player on one machine now
gets its own slot; the identical address:port keeps WinQuake's reconnect
handling. The clients here are still started one at a time (harmless);
whether two connects landing in the same instant both survive signon is a
separate, untested question.
*/

const basePort = Number(argValue("port", "26360"));
const classic = contentById("classic-id1");
const rerelease = contentById("rr-id1");

console.log(`t_cross: ports=${basePort}..${basePort + 3}`);

async function phase(seat: SeatT, name: string, timeoutMs: number): Promise<boolean> {
  return await waitFor(seat, marker(name), timeoutMs);
}

/** Connect, record from before the connect, settle, report. */
function joinScript(connect: string, demo: string | null, extra: readonly string[] = []): string[] {
  return [
    "cl_shownet 0",
    ...waits(120),
    ...extra,
    "disconnect",
    ...(demo === null ? [] : [`record ${demo}`]),
    connect,
    ...waits(500),
    echoMarker("IN"),
    ...waits(120),
    ...(demo === null ? [] : ["stop"]),
    ...waits(60),
    echoMarker("DONE"),
    ...waits(600),
  ];
}

// ---------------------------------------------------------------------------
// 1. classic client content, re-release server -- the server's progs win
// ---------------------------------------------------------------------------

const port1 = basePort;
const sv1 = startServer("t_cross_rr_sv", [
  ...baseArgs(rerelease, "e2e_t_x1_sv"),
  "-port", String(port1),
  "+deathmatch", "0",
  "+sv_ruleset", "auto",
  "+sv_protocol", "666",
  "+map", "e1m1",
]);
const up1 = await waitFor(sv1, /Server protocol \d+ \(flags/, 90000);
check("the re-release server boots e1m1", up1, up1 ? "" : `no "Server protocol" line in ${sv1.log}`);
check("the server's own progs set the ruleset, not the client's tree", serverRuleset(readLog(sv1)) === "rerelease", `server printed ${serverRuleset(readLog(sv1)) ?? "nothing"}`);

const cl1 = startClient(
  "t_cross_classic_cl",
  "e2e_t_x1_cl",
  [...baseArgs(classic, "e2e_t_x1_cl"), "-port", String(port1)],
  joinScript("connect 127.0.0.1", "t_x1"),
);
const in1 = await phase(cl1, "IN", 90000);
check("a classic-content client enters a re-release server's game", in1 && /entered the game/.test(readLog(sv1)), (readLog(sv1).match(/.*entered the game.*/g) ?? []).slice(-1).join("") || `no player entered (client log ${cl1.log})`);

const log1 = readLog(cl1);
check(
  "the two seats really do have different content mounted",
  /\/id1\/PAK0\.PAK/i.test(log1) && !/rerelease\//.test(log1) && /rerelease\//.test(readLog(sv1)),
  `client reads ${/rerelease\//.test(log1) ? "the re-release tree" : "the classic tree"}; server reads ${/rerelease\//.test(readLog(sv1)) ? "the re-release tree" : "the classic tree"}`,
);

await phase(cl1, "DONE", 60000);
const demo1 = recordedDemoPath(log1) === null ? null : readDemoServerInfo(recordedDemoPath(log1) ?? "");
const p1 = serverProtocolLine(readLog(sv1));
check(
  "the classic client negotiated the re-release server's protocol",
  demo1 !== null && p1 !== null && demo1.protocol === p1.protocol && demo1.flags === p1.flags,
  demo1 === null ? "no serverinfo in the client's demo" : `server ${p1 === null ? "?" : p1.protocol}/0x${(p1?.flags ?? 0).toString(16)}, client ${demo1.protocol}/0x${demo1.flags.toString(16)}`,
);

killSeat(cl1);
killSeat(sv1);

// ---------------------------------------------------------------------------
// 2. a 666-forced client against an auto server on a small map
// ---------------------------------------------------------------------------

const port2 = basePort + 1;
const sv2 = startServer("t_cross_auto_sv", [
  ...baseArgs(classic, "e2e_t_x2_sv"),
  "-port", String(port2),
  "+deathmatch", "0",
  "+sv_protocol", "auto",
  "+map", "e1m1",
]);
await waitFor(sv2, /Server protocol \d+ \(flags/, 90000);
const p2 = serverProtocolLine(readLog(sv2));
check("sv_protocol auto answers 666 for a small BSP29 map", p2 !== null && p2.protocol === 666, `auto answered ${p2 === null ? "nothing" : p2.protocol} for e1m1`);

const cl2 = startClient(
  "t_cross_666_cl",
  "e2e_t_x2_cl",
  [...baseArgs(classic, "e2e_t_x2_cl"), "-port", String(port2)],
  joinScript("connect 127.0.0.1", "t_x2", ["cl_protocol 666"]),
);
const in2 = await phase(cl2, "IN", 90000);
check("a cl_protocol 666 client joins the auto server", in2 && /entered the game/.test(readLog(sv2)), (readLog(sv2).match(/.*entered the game.*/g) ?? []).slice(-1).join("") || `no player entered (client log ${cl2.log})`);

await phase(cl2, "DONE", 60000);
const path2 = recordedDemoPath(readLog(cl2));
const demo2 = path2 === null ? null : readDemoServerInfo(path2);
check("the 666 client and the auto server agreed on 666", demo2 !== null && demo2.protocol === 666, demo2 === null ? "no serverinfo in the client's demo" : `client recorded protocol ${demo2.protocol}`);

killSeat(cl2);
killSeat(sv2);

// ---------------------------------------------------------------------------
// 3. three clients at once on protocol 999 with max_edicts raised
// ---------------------------------------------------------------------------

const port3 = basePort + 2;
const RAISED_EDICTS = "8192";
const sv3 = startServer("t_cross_999_sv", [
  ...baseArgs(classic, "e2e_t_x3_sv"),
  "-port", String(port3),
  "+deathmatch", "1",
  "+max_edicts", RAISED_EDICTS,
  "+sv_protocol", "999",
  "+map", "dm4",
]);
await waitFor(sv3, /Server protocol \d+ \(flags/, 90000);
const p3 = serverProtocolLine(readLog(sv3));
check("the server serves dm4 on protocol 999", p3 !== null && p3.protocol === 999, `got ${p3 === null ? "nothing" : p3.protocol}`);
check("protocol 999 carries its protocol flags", p3 !== null && p3.flags === 0x82, `flags 0x${(p3?.flags ?? 0).toString(16)}`);

const maxEdictsOut = await svQuery(sv3, "max_edicts", "ME");
check(`the server is running with max_edicts raised to ${RAISED_EDICTS}`, new RegExp(`"max_edicts" is "${RAISED_EDICTS}"`).test(maxEdictsOut), maxEdictsOut.replace(/\n/g, " | ").slice(0, 160));

// One at a time (see the same-address note above); the claim under test is
// that three clients HOLD a slot at once, which staggering does not weaken.
const trio: SeatT[] = [];
for (const n of ["1", "2", "3"]) {
  const seat = startClient(
    `t_cross_999_cl${n}`,
    `e2e_t_x3_c${n}`,
    [...baseArgs(classic, `e2e_t_x3_c${n}`), "-port", String(port3)],
    joinScript("connect 127.0.0.1", n === "1" ? "t_x3" : null, [`name TRIO${n}`]),
  );
  trio.push(seat);
  await waitFor(sv3, new RegExp(`TRIO${n} entered the game`), 120000);
}

const status3 = await svQuery(sv3, "status", "S3");
check("all three clients hold a slot at once", /players:\s*3 active/.test(status3), (status3.match(/players:.*/g) ?? []).join(" | "));
check(
  "each of the three is named on the server",
  ["TRIO1", "TRIO2", "TRIO3"].every((n) => status3.includes(n)),
  status3.replace(/\n/g, " | ").slice(0, 240),
);

await phase(trio[0], "DONE", 90000);
const path3 = recordedDemoPath(readLog(trio[0]));
const demo3 = path3 === null ? null : readDemoServerInfo(path3);
check(
  "a client on the three-way 999 game negotiated 999 with its flags",
  demo3 !== null && demo3.protocol === 999 && demo3.flags === 0x82,
  demo3 === null ? "no serverinfo in the client's demo" : `client recorded ${demo3.protocol}/0x${demo3.flags.toString(16)}`,
);

for (const c of trio) killSeat(c);
killSeat(sv3);

// ---------------------------------------------------------------------------
// 4. cl_protocol forcing the connect rule both ways
// ---------------------------------------------------------------------------

const port4 = basePort + 3;
const sv4 = startServer("t_cross_force_sv", [
  ...baseArgs(classic, "e2e_t_x4_sv"),
  "-port", String(port4),
  "+deathmatch", "0",
  "+sv_protocol", "666",
  "+map", "e1m1",
]);
await waitFor(sv4, /Server protocol \d+ \(flags/, 90000);

// `cl_protocol nq` + "host:port": the port suffix alone would mean QuakeWorld.
const cl4 = startClient(
  "t_cross_force_nq",
  "e2e_t_x4_nq",
  [...baseArgs(classic, "e2e_t_x4_nq"), "-port", String(port4)],
  joinScript(`connect 127.0.0.1:${port4}`, null, ["cl_protocol nq"]),
);
const in4 = await phase(cl4, "IN", 90000);
check(
  "`cl_protocol nq` keeps a ported address on the NetQuake path",
  in4 && /entered the game/.test(readLog(sv4)),
  (readLog(sv4).match(/.*entered the game.*/g) ?? []).slice(-1).join("") || `no player entered (client log ${cl4.log})`,
);
check(
  "the forced NetQuake client ran NET_Connect, not the QuakeWorld handshake",
  /Connection accepted/.test(readLog(cl4)) && !/challenge/.test(readLog(cl4)),
  (readLog(cl4).match(/.*(Connection accepted|challenge|Connecting to).*/g) ?? []).slice(-2).join(" | ") || "no connect line at all",
);
killSeat(cl4);
killSeat(sv4);
await sleep(2000);

// `cl_protocol qw` + a bare address: no port suffix, so only the cvar can
// send this to QuakeWorld. The handshake goes to the QuakeWorld default port
// 27500, which this driver does not own: when another process holds it (a
// stray qwsv on this host, for one), the scenario is skipped rather than
// sending a challenge into a foreign server.
const port27500Holder = Bun.spawnSync(["ss", "-lunp"]).stdout.toString().split("\n").find((l) => /:27500\b/.test(l));
const seatsForFatalScan: SeatT[] = [sv1, sv2, sv3, sv4, cl1, cl2, cl4];
if (port27500Holder !== undefined) {
  check("`cl_protocol qw` sends a bare address to the QuakeWorld handshake", true, `SKIPPED: UDP 27500 is held by another process (${port27500Holder.trim().slice(0, 100)})`);
} else {
const cl5 = startClient(
  "t_cross_force_qw",
  "e2e_t_x4_qw",
  [...baseArgs(classic, "e2e_t_x4_qw"), "-port", String(port4)],
  ["cl_shownet 0", ...waits(120), "cl_protocol qw", "disconnect", "connect 127.0.0.1", ...waits(400), echoMarker("TRIED"), ...waits(200), echoMarker("DONE")],
);
await phase(cl5, "TRIED", 90000);
const log5 = readLog(cl5);
// The QuakeWorld path prints "Connecting to <address>..." (CL_CheckForResend)
// and sends a getchallenge to the address it resolved -- for a bare host that
// is the default QuakeWorld server port. The NetQuake path prints "trying..."
// instead. The client's own "challenge" line is printed only when a server
// ANSWERS (CL_ConnectionlessPacket), and no server is stood up here, so the
// resend line is the evidence.
check(
  "`cl_protocol qw` sends a bare address to the QuakeWorld handshake",
  /Connecting to 127\.0\.0\.1\.\.\./.test(log5) && !/trying\.\.\./.test(log5),
  (log5.match(/.*(Connecting to|trying\.\.\.|challenge).*/g) ?? []).slice(-2).join(" | ") || "no connect attempt line at all",
);
killSeat(cl5);
seatsForFatalScan.push(cl5);
}

check(
  "no seat hit a fatal engine error",
  !/Sys_Error|SysError|Fatal:|Host_Error/.test(seatsForFatalScan.map(readLog).join("\n")),
  seatsForFatalScan.map(readLog).join("\n").match(/.*(Sys_Error|Fatal:|Host_Error).*/g)?.slice(0, 2).join(" | ") ?? "",
);

summary("t_cross");
