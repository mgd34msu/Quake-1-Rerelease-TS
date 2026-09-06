/*
Self-sufficient test for the QuakeWorld server's `ent->v.netname` lifetime
(QW/server/sv_user.c:354, QW/server/sv_main.c's SV_ExtractFromUserinfo).

The C runs `ent->v.netname = PR_SetString(host_client->name)` exactly once,
in SV_Spawn_f. It never re-runs it on a rename, and it does not have to:
QW's PR_SetString stores the `char *` itself in `pr_strtbl[]`, and
`host_client->name` is a char array *inside* client_t, so when
SV_ExtractFromUserinfo's `strncpy(cl->name, val, ...)` overwrites those
bytes every later `PR_GetString(netname)` reads the new name. QuakeC
obituaries (`bprint(self.netname)` in ClientKill, `attacker.netname` in
Obituary) therefore follow a rename with no further engine call.

A JS string is a value, not a pointer, so `PR_SetString(host_client.name)`
froze netname at the name the client spawned with: connect/disconnect
messages (which read `cl->name` directly) showed the new name while every
death and frag message kept the old one. src/qw/server/progs.ts's
`PR_SetStringRef` is the aliasing the C gets for free -- the table entry
holds the reader instead of a snapshot -- and sv_user.ts's SV_Spawn_f uses
it.

Two levels here:
- In-process unit tests of PR_SetStringRef itself (aliasing, and dedup on
  holder identity the way the C dedups on pointer identity, so a rename
  costs no MAX_PRSTR slot).
- A child-process end-to-end: a real qwsv boot on the shared
  test/support/qwsv_fixture.ts basedir (real retail qw/qwprogs.dat), a
  client spawned through the real SV_Spawn_f/SV_Begin_f, renamed through the
  real SV_ExtractFromUserinfo, then killed through the real `kill` user
  command so retail QuakeC's `ClientKill` broadcasts `self.netname`. The
  boot runs in a child for exactly the reason test/qwsv_boot.test.ts's
  header gives: SV_Init registers `map`, `status`, `kick` and thirty more
  names into src/common/cmd.ts's one process-wide first-wins table, which
  WinQuake's Host_InitCommands also registers into.

Shared singletons the in-process half touches and resets itself (standing
order 15): src/qw/server/progs.ts's engine-string table, cleared with
PR_ClearEngineStrings in both beforeEach and afterAll.
*/

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { PR_ClearEngineStrings, PR_GetString, PR_SetString, PR_SetStringRef, num_prstr } from "../src/qw/server/progs";
import { HAVE_QWPROGS } from "./support/fixture_availability";

const repoRoot = join(import.meta.dir, "..");

const JSON_MARKER = "<<<QWSV_NAME_JSON>>>";

// Boots a real qwsv, spawns one client through the real command path,
// renames it, kills it, and prints one JSON line of what netname read at
// each step. Kept as a script rather than a checked-in driver module so this
// file adds no source file outside test/.
const CHILD_SCRIPT = `
import { buildQwsvFixture, destroyQwsvFixture, QWSV_FIXTURE_MAP } from "./test/support/qwsv_fixture";
import { Sys_Main_Init, runFrames } from "./src/qw/main_sv";
import { NET_Ready, NET_Shutdown, NetadrT } from "./src/qw/net_udp";
import { Info_SetValueForKey } from "./src/qw/common";
import { MAX_INFO_STRING } from "./src/qw/bothdefs";
import { Netchan_Setup } from "./src/qw/net_chan";
import { SZ_Clear } from "./src/common/sizebuf";
import { Cbuf_AddText, Cbuf_Execute } from "./src/common/cmd";
import { EDICT_NUM, EDICT_TO_PROG, PR_GetString, PR_SetString, qwpr } from "./src/qw/server/progs";
import { ED_FindFunction } from "./src/qw/server/pr_edict";
import { PR_ExecuteProgram } from "./src/qw/server/pr_exec";
import { OFS_PARM0, OFS_PARM1 } from "./src/progs/pr_comp";
import { ClientStateT, svState, sv, svs } from "./src/qw/server/server";
import { SV_ExecuteUserCommand } from "./src/qw/server/sv_user";
import { SV_ExtractFromUserinfo, SV_Shutdown } from "./src/qw/server/sv_main";

const fixture = buildQwsvFixture("qwsv-name-child-");
const out = { spawned: "", afterRename: "", clName: "", reliable: "" };
try {
  Sys_Main_Init(["qwsv", "-basedir", fixture.baseDir, "-port", "0", "+map", QWSV_FIXTURE_MAP]);
  await NET_Ready();
  runFrames(5, 0.05);
  // the fixture map carries only an info_player_start, which retail QuakeC's
  // SelectSpawnPoint reaches through its non-deathmatch branch
  Cbuf_AddText("deathmatch 0\\n");
  Cbuf_Execute();

  const cl = svs.clients[0];
  cl.state = ClientStateT.cs_connected;
  cl.spectator = 0;
  cl.edict = EDICT_NUM(1);
  cl.userinfo = Info_SetValueForKey("", "name", "Alpha", MAX_INFO_STRING);
  Netchan_Setup(cl.netchan, new NetadrT(), 0);
  // what SV_ConnectClient does for a real connect (sv_main.c)
  cl.datagram.allowoverflow = true;
  cl.datagram.data = cl.datagram_buf;
  cl.datagram.maxsize = cl.datagram_buf.length;
  SV_ExtractFromUserinfo(cl);
  svState.host_client = cl;

  SV_ExecuteUserCommand("spawn " + svs.spawncount + " 0");
  SV_ExecuteUserCommand("begin " + svs.spawncount);
  out.spawned = PR_GetString(cl.edict.v.netname);

  // the rename the C performs by overwriting client_t's own name buffer
  cl.userinfo = Info_SetValueForKey(cl.userinfo, "name", "Bob", MAX_INFO_STRING);
  SV_ExtractFromUserinfo(cl);
  out.afterRename = PR_GetString(cl.edict.v.netname);
  out.clName = cl.name;

  // Retail QuakeC's own obituary. client.qc's
  //   ClientObituary(targ, attacker): if (targ == attacker) {
  //     bprint(attacker.netname); bprint(" suicides"); }
  // is the death message the reported defect is about, and it reads netname
  // through PR_GetString exactly as every other obituary branch does. Calling
  // it directly on the renamed client's edict keeps this independent of where
  // the fixture map's QuakeC spawn code happens to put a player.
  const ent = cl.edict;
  ent.v.classname = PR_SetString("player");
  ent.v.frags = 0;
  SZ_Clear(cl.netchan.message);
  const globals = qwpr.global_struct;
  const gw = qwpr.globals;
  if (globals === null || gw === null) throw new Error("progs not loaded");
  const obituary = ED_FindFunction("ClientObituary");
  if (obituary === null) throw new Error("qwprogs has no ClientObituary");
  globals.time = sv.time;
  globals.self = EDICT_TO_PROG(ent);
  gw.i[OFS_PARM0] = EDICT_TO_PROG(ent);
  gw.i[OFS_PARM1] = EDICT_TO_PROG(ent);
  PR_ExecuteProgram(qwpr.functions.indexOf(obituary));

  const msg = cl.netchan.message;
  let text = "";
  for (let i = 0; i < msg.cursize; i++) {
    const b = msg.data === null ? 0 : msg.data[i];
    text += b >= 32 && b < 127 ? String.fromCharCode(b) : " ";
  }
  out.reliable = text;

  SV_Shutdown();
  NET_Shutdown();
} finally {
  destroyQwsvFixture(fixture);
}
console.log("${JSON_MARKER}" + JSON.stringify(out));
process.exit(0);
`;

interface ChildResult {
  stdout: string;
  exitCode: number | null;
  json: { spawned: string; afterRename: string; clName: string; reliable: string };
}

let cached: ChildResult | null = null;

async function runChild(): Promise<ChildResult> {
  if (cached) return cached;
  const proc = Bun.spawn(["bun", "--eval", CHILD_SCRIPT], {
    cwd: repoRoot,
    env: { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  const line = stdout.split("\n").find((l) => l.includes(JSON_MARKER));
  if (!line) throw new Error(`child produced no ${JSON_MARKER} line.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  const parsed: unknown = JSON.parse(line.slice(line.indexOf(JSON_MARKER) + JSON_MARKER.length));
  if (typeof parsed !== "object" || parsed === null) throw new Error("child JSON is not an object");
  const rec: Record<string, unknown> = { ...parsed };
  const str = (k: string): string => (typeof rec[k] === "string" ? rec[k] : "");
  cached = {
    stdout: stdout + stderr,
    exitCode,
    json: { spawned: str("spawned"), afterRename: str("afterRename"), clName: str("clName"), reliable: str("reliable") },
  };
  return cached;
}

describe("PR_SetStringRef aliases a holder the way QW's pr_strtbl[] aliases a char *", () => {
  beforeEach(() => {
    PR_ClearEngineStrings();
  });

  afterAll(() => {
    PR_ClearEngineStrings();
  });

  test("PR_GetString reads the holder's current value, not a snapshot", () => {
    const client = { name: "Alpha" };
    const netname = PR_SetStringRef(client, () => client.name);

    expect(PR_GetString(netname)).toBe("Alpha");
    client.name = "Bob";
    expect(PR_GetString(netname)).toBe("Bob");
    client.name = "";
    expect(PR_GetString(netname)).toBe("");
  });

  test("the same holder reuses one table slot, so renames cost no MAX_PRSTR room", () => {
    const client = { name: "Alpha" };
    const first = PR_SetStringRef(client, () => client.name);
    expect(num_prstr()).toBe(1);

    client.name = "Bob";
    const second = PR_SetStringRef(client, () => client.name);
    expect(second).toBe(first);
    expect(num_prstr()).toBe(1);
  });

  test("two holders get two slots, and a plain PR_SetString is unaffected", () => {
    const a = { name: "Alpha" };
    const b = { name: "Beta" };
    const na = PR_SetStringRef(a, () => a.name);
    const nb = PR_SetStringRef(b, () => b.name);
    expect(na).not.toBe(nb);

    const plain = PR_SetString("Alpha");
    expect(PR_GetString(plain)).toBe("Alpha");
    a.name = "Bob";
    // the value copy stays put; only the ref follows
    expect(PR_GetString(plain)).toBe("Alpha");
    expect(PR_GetString(na)).toBe("Bob");
    expect(PR_GetString(nb)).toBe("Beta");
  });

  test("PR_ClearEngineStrings drops refs as PR_LoadProgs's num_prstr reset does", () => {
    const client = { name: "Alpha" };
    PR_SetStringRef(client, () => client.name);
    expect(num_prstr()).toBe(1);
    PR_ClearEngineStrings();
    expect(num_prstr()).toBe(0);
  });
});

describe.skipIf(!HAVE_QWPROGS)("a real qwsv: netname follows a rename all the way into a QuakeC obituary", () => {
  test("the child boot completes", async () => {
    const r = await runChild();
    expect(r.exitCode).toBe(0);
  }, 120_000);

  test("netname reads the spawn-time name", async () => {
    const r = await runChild();
    expect(r.json.spawned).toBe("Alpha");
  }, 120_000);

  test("SV_ExtractFromUserinfo's rename is visible through netname", async () => {
    const r = await runChild();
    expect(r.json.clName).toBe("Bob");
    expect(r.json.afterRename).toBe("Bob");
  }, 120_000);

  test("retail QuakeC's ClientObituary broadcasts the new name, not the old one", async () => {
    const r = await runChild();
    // the self-kill branch retail qwprogs picks here reads
    // "Bob becomes bored with life"; the branch wording is QuakeC's business,
    // the name in it is the engine's.
    expect(r.json.reliable.trim().length).toBeGreaterThan(0);
    expect(r.json.reliable).toContain("Bob");
    expect(r.json.reliable).not.toContain("Alpha");
  }, 120_000);
});
