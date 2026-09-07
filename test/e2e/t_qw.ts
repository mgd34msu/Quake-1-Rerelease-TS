/*
t_qw -- QuakeWorld, both wire protocols, both ways into a QuakeWorld session.

  bun test/e2e/t_qw.ts --protocol 28 --port 26340
  bun test/e2e/t_qw.ts --protocol 29 --port 26350

Every seat is the one compiled binary; there is no separate `qwsv`/`qwcl`
build any more (`qwsv` IS `src/main.ts -dedicated -qw`, `qwcl` IS
`src/main.ts -qw`). The scenarios run STRICTLY one after another, because
QuakeWorld's client port is the hardcoded `PORT_CLIENT = 27001` in
src/qw/protocol.ts and only one QuakeWorld client can be alive on a host at
that port. Scenario 4 needs two at once -- a listen server's own client half
plus a guest -- and moves the guest's socket with src/qw/net_udp.ts's
`-clientport`, which is the only place in this family that does:

  1. `-dedicated -qw` server with qwprogs on the asked-for protocol, one `-qw`
     client: the player enters, moves and fires. A client that could not read
     the protocol the map chose would be turned away by SV_New_f
     (src/qw/server/sv_user.ts), so entering the game IS the client half of
     the protocol agreement.
  2. the same binary from a DEFAULT (NetQuake) boot reaching the same server
     with `connect host:port` -- src/common/profile.ts's connect rule says an
     address carrying an explicit port means the QuakeWorld handshake.
  3. `sv_qwprotocol auto`: 28 on dm1, which 28 can carry, and 29 on e3m6,
     whose 861-entity lump is past what 28's nine-bit entity field can name
     (src/qw/server/sv_init.ts's SV_QwAutoProtocol).
  4. a QuakeWorld LISTEN server from a default boot: `sv_profile qw` then
     `map dm1` in a plain client process (src/common/host_cmd.ts's
     Host_Map_QW_f), which then takes a `-qw` client.

Scenarios 3-at-28 and 4 run on the `--protocol 28` invocation; 3-at-29 runs on
the `--protocol 29` one, so neither invocation repeats the other's work.

Every client here is a POLLED client (t_lib's startPolledQwClient): a
QuakeWorld join is driven by the server stuffing commands into the client's
command buffer, so the client must not be sitting on a long queue of its own.
See that function's comment.

The QuakeWorld seats run against this family's own basedir (t_lib's
qwBasedir), not the retail tree -- see that function's comment.
*/

import {
  argValue,
  check,
  contentById,
  edictNumber,
  edictVector,
  killSeat,
  lastEdict,
  qwBasedir,
  readLog,
  serverProtocolLine,
  sleep,
  startPolledClient,
  startPolledQwClient,
  startServer,
  summary,
  type SeatT,
  svQuery,
  waitFor,
} from "./t_lib";
import { homedirArgs } from "./q1data";

const protocolArg = argValue("protocol", "28");
const basePort = Number(argValue("port", "26340"));
const BASE = qwBasedir();

console.log(`t_qw: protocol=${protocolArg} basedir=${BASE} ports=${basePort}..${basePort + 3}`);

const qwServerArgs = (port: number, proto: string, map: string): string[] => [
  "-qw",
  "-basedir", BASE,
  ...homedirArgs("qw"),
  "-nosound",
  "-port", String(port),
  "+sv_qwprotocol", proto,
  "+map", map,
];

/*
The QuakeWorld clients hold +forward and +attack from their opening cfg,
before they have even connected, and never take a second console command.

They cannot take one. Every line of a client's cfg is executed AHEAD of
anything the server later stuffs into the same buffer (Cbuf_AddText appends,
`exec` splices in front), and a QuakeWorld join is FINISHED by stuffed text --
`skins`, and the `begin` behind it. So a cfg's last line always runs before
the player is in the game, and the buffer is empty from then on: there is no
moment at which a driver can hand a joined QuakeWorld client new console
input. Holding the movement keys from the start sidesteps that -- they are
key states, so the player walks and shoots the instant it spawns -- and the
driver reads the result from the server's `edict 1` instead.
*/

// ---------------------------------------------------------------------------
// 1. -dedicated -qw + a -qw client on the asked-for protocol
// ---------------------------------------------------------------------------

const port1 = basePort;
const sv1 = startServer(`t_qw_${protocolArg}_sv`, qwServerArgs(port1, protocolArg, "dm1"));
const sv1up = await waitFor(sv1, /Server protocol \d+ \(flags/, 60000);
check(`qwsv boots dm1 on sv_qwprotocol ${protocolArg}`, sv1up, sv1up ? "" : `no "Server protocol" line in ${sv1.log}`);

const p1 = serverProtocolLine(readLog(sv1));
check(
  "the QuakeWorld server serves the protocol it was asked for",
  p1 !== null && p1.protocol === Number(protocolArg),
  `asked for ${protocolArg}, got ${p1 === null ? "nothing" : p1.protocol}`,
);

const cl1 = startPolledQwClient(`t_qw_${protocolArg}_cl`, ["-qw", "-basedir", BASE, "-nosound"], ["cl_shownet 0", `connect 127.0.0.1:${port1}`, "+forward", "+attack"]);
const entered1 = await waitFor(sv1, /entered the game/, 180000);
check(
  `a -qw client reads protocol ${protocolArg} and enters the game`,
  entered1,
  (readLog(sv1).match(/.*entered the game.*/g) ?? []).slice(-1).join("") || `the server never announced a player entering (client log ${cl1.seat.log})`,
);

// Two samples taken while the client is walking and shooting.
const a1 = lastEdict(await svQuery(sv1, "edict 1", "QA"), 1);
await sleep(5000);
const b1 = lastEdict(await svQuery(sv1, "edict 1", "QB"), 1);
const oa = edictVector(a1, "origin");
const ob = edictVector(b1, "origin");
check(
  "the QuakeWorld player moves when the client holds +forward",
  oa !== null && ob !== null && Math.hypot(ob[0] - oa[0], ob[1] - oa[1], ob[2] - oa[2]) > 8,
  `origin ${JSON.stringify(oa)} -> ${JSON.stringify(ob)}`,
);
check(
  "the QuakeWorld player's ammo drops when the client holds +attack",
  edictNumber(b1, "currentammo") < edictNumber(a1, "currentammo"),
  `currentammo ${edictNumber(a1, "currentammo")} -> ${edictNumber(b1, "currentammo")}`,
);

killSeat(cl1.seat);
killSeat(sv1);
await sleep(3000); // PORT_CLIENT 27001 has to come free before the next QuakeWorld client

// ---------------------------------------------------------------------------
// 2. the same binary from a DEFAULT (NetQuake) boot, via `connect host:port`
// ---------------------------------------------------------------------------

const port2 = basePort + 1;
const sv2 = startServer(`t_qw_${protocolArg}_sv2`, qwServerArgs(port2, protocolArg, "dm1"));
await waitFor(sv2, /Server protocol \d+ \(flags/, 60000);

// A default boot: no -qw. src/common/profile.ts's connectProfileFor sees the
// explicit :port and runs the QuakeWorld handshake instead of NET_Connect.
const nqGame = "e2e_t_qwx";
const classic = contentById("classic-id1");
const cl2 = startPolledClient(
  `t_qw_${protocolArg}_nqboot`,
  nqGame,
  ["-basedir", classic.basedir, "-norerelease", ...homedirArgs(nqGame), "-game", nqGame, "-nosound"],
  ["cl_shownet 0", "disconnect", `connect 127.0.0.1:${port2}`],
);
const entered2 = await waitFor(sv2, /entered the game/, 180000);
check(
  "a default (NetQuake) boot reaches a QuakeWorld server with `connect host:port`",
  entered2,
  (readLog(sv2).match(/.*entered the game.*/g) ?? []).slice(-1).join("") || `the server never announced a player entering (client log ${cl2.seat.log})`,
);
check(
  "the default boot ran the QuakeWorld handshake, not NET_Connect",
  /Connecting to 127\.0\.0\.1:/.test(readLog(cl2.seat)) && /challenge/.test(readLog(cl2.seat)),
  (readLog(cl2.seat).match(/.*(Connecting to|challenge|trying\.\.\.).*/g) ?? []).slice(-2).join(" | ") || "neither a QuakeWorld nor a NetQuake connect line",
);

killSeat(cl2.seat);
killSeat(sv2);
await sleep(3000);

// ---------------------------------------------------------------------------
// 3. sv_qwprotocol auto
// ---------------------------------------------------------------------------

const autoMap = protocolArg === "29" ? "e3m6" : "dm1";
const autoWant = protocolArg === "29" ? 29 : 28;
const port3 = basePort + 2;
const sv3 = startServer(`t_qw_${protocolArg}_auto`, qwServerArgs(port3, "auto", autoMap));
const sv3up = await waitFor(sv3, /Server protocol \d+ \(flags/, 120000);
const p3 = serverProtocolLine(readLog(sv3));
check(
  `sv_qwprotocol auto picks ${autoWant} for ${autoMap}`,
  sv3up && p3 !== null && p3.protocol === autoWant,
  `auto answered ${p3 === null ? "nothing" : p3.protocol} for ${autoMap}`,
);
killSeat(sv3);
await sleep(1000);

// ---------------------------------------------------------------------------
// 4. a QuakeWorld LISTEN server from a default boot (--protocol 28 only)
// ---------------------------------------------------------------------------

const extraSeats: SeatT[] = [];

if (protocolArg === "28") {
  const port4 = basePort + 3;
  /*
  A DEFAULT boot, so its opening cfg has to sit somewhere a NETQUAKE search
  path reaches. `<basedir>/qw`, where startPolledQwClient writes, is mounted
  only once the QuakeWorld profile comes up -- which is what this cfg exists
  to cause -- so the seat runs out of a writable `-game` directory under the
  homedir, the same place scenario 2's NetQuake seat runs from. `-basedir
  BASE` stays: `sv_profile qw` + `map dm1` needs this family's own writable
  `qw/qwprogs.dat` (t_lib's qwBasedir).
  */
  const listenGame = "e2e_t_qwl";
  const listen = startPolledClient(
    "t_qw_listen_host",
    listenGame,
    ["-basedir", BASE, ...homedirArgs(listenGame), "-game", listenGame, "-nosound", "-port", String(port4)],
    ["cl_shownet 0", "disconnect", "sv_profile qw", "map dm1"],
  );
  const spawned = await waitFor(listen.seat, /Server protocol \d+ \(flags/, 150000);
  const pl = serverProtocolLine(readLog(listen.seat));
  check(
    "`sv_profile qw` + `map dm1` from a default boot brings up a QuakeWorld server",
    spawned && pl !== null,
    pl === null ? `no "Server protocol" line in ${listen.seat.log}` : `protocol ${pl.protocol}`,
  );
  const hostIn = await waitFor(listen.seat, /entered the game/, 180000);
  check(
    "the listen host's own player is in its QuakeWorld game",
    hostIn,
    (readLog(listen.seat).match(/.*entered the game.*/g) ?? []).slice(-1).join("") || `the listen server never announced a player entering (${listen.seat.log})`,
  );

  /*
  Two things the guest needs that a lone QuakeWorld client does not.

  `-clientport`, because the listen host's own client half is already sitting
  on QuakeWorld's hardcoded PORT_CLIENT (27001) and a second QuakeWorld client
  on this machine has nothing left to bind -- it dies in UDP_OpenSocket's
  Sys_Error. The two players are on one box only because this is a test; the
  parameter is src/qw/net_udp.ts's addition for exactly that case.

  And a name of its own, because the listen process prints "entered the game"
  TWICE for ONE player: once where its server half broadcasts the line and
  once where its client half receives it. A count of that line is therefore no
  evidence that a second player arrived. The guest's cfg runs under the
  QuakeWorld profile, where `name` is QW's userinfo cvar, so the name reaches
  the server in the connect's userinfo string and the check below reads it out
  of the listen server's own announcement.
  */
  const guest = startPolledQwClient(
    "t_qw_listen_guest",
    ["-qw", "-basedir", BASE, "-nosound", "-clientport", String(port4 + 1)],
    ["cl_shownet 0", "name qwguest", `connect 127.0.0.1:${port4}`, "+forward", "+attack"],
  );
  const guestIn = await waitFor(listen.seat, /qwguest entered the game/, 180000);
  check(
    "a -qw client joins the listen server",
    guestIn,
    (readLog(listen.seat).match(/.*entered the game.*/g) ?? []).join(" | ") || `no player entered; guest log ${guest.seat.log}`,
  );
  extraSeats.push(listen.seat, guest.seat);
  killSeat(guest.seat);
  killSeat(listen.seat);
}

const allLogs = [sv1, cl1.seat, sv2, cl2.seat, sv3, ...extraSeats].map(readLog).join("\n");
check("no QuakeWorld seat hit a fatal engine error", !/Sys_Error|SysError|Fatal:|Host_Error/.test(allLogs), allLogs.match(/.*(Sys_Error|Fatal:|Host_Error).*/g)?.slice(0, 2).join(" | ") ?? "");

summary(`t_qw ${protocolArg}`);
