/*
U18: the QuakeWorld limits that stopped being QuakeWorld's own.

  - the edict table is the shared `max_edicts` cvar (src/common/host.ts's
    Host_MaxEdicts), not QW bothdefs.h's 768, so qwProfile.maxEdicts reads
    sv.max_edicts the way nqProfile does;
  - what protocol 28 can NAME is a separate, smaller number that belongs to
    the wire: 512 entity numbers and 256 precache indices, both on the codec.
    An entity or a precache entry above the line is left out of the message
    with a developer warning, where the seed's SV_WriteDelta called SV_Error
    and killed the server;
  - protocol 29 (src/common/protocol/qw29.ts) is the variant with room.

Standing order 13 / rule 15: `sv`, `svs`, `svState` and the `max_edicts` cvar
are process-wide singletons other suites touch. Every field this file writes
is captured in beforeAll and put back in afterAll, and each test restores what
it changed. Nothing here needs a progs.dat, a map, a socket or a renderer.
*/

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { Host_MaxEdicts, max_edicts } from "../src/common/host";
import { Cmd_TokenizeString } from "../src/common/cmd";
import { MSG_ReadByte, MSG_ReadShort, MSG_ReadString, MSG_BeginReading, SizeBuf, msgState, net_message } from "../src/common/sizebuf";
import { qwProfile } from "../src/progs/profiles/qw";
import { ClientStateT, ClientT, sv, svState, svs } from "../src/qw/server/server";
import { SV_WriteDelta } from "../src/qw/server/sv_ents";
import { SV_Modellist_f, svResetPrecacheWarnings } from "../src/qw/server/sv_user";
import { SV_CountQwEntityLump } from "../src/qw/server/sv_init";
import { PROTOCOL_VERSION, QwEntityStateT, SvcOpsT } from "../src/qw/protocol";
import { MAX_MSGLEN } from "../src/qw/bothdefs";
import { PROTOCOL_QW_WIDE, qw29Codec } from "../src/common/protocol/qw29";
import { qw28Codec } from "../src/common/protocol/qw28";

let savedNetData: Uint8Array;

const saved = {
  protocol: 0,
  protocolflags: 0,
  maxEdicts: 0,
  modelPrecache: [] as Array<string | null>,
  spawncount: 0,
  hostClient: null as ClientT | null,
  maxEdictsCvar: "",
  netCursize: 0,
  netMaxsize: 0,
  readcount: 0,
  badread: false,
};

beforeAll(() => {
  saved.protocol = sv.protocol;
  saved.protocolflags = sv.protocolflags;
  saved.maxEdicts = sv.max_edicts;
  saved.modelPrecache = sv.model_precache;
  saved.spawncount = svs.spawncount;
  saved.hostClient = svState.host_client;
  saved.maxEdictsCvar = max_edicts.string;
  savedNetData = net_message.data;
  saved.netCursize = net_message.cursize;
  saved.netMaxsize = net_message.maxsize;
  saved.readcount = msgState.readcount;
  saved.badread = msgState.badread;
});

afterAll(() => {
  sv.protocol = saved.protocol;
  sv.protocolflags = saved.protocolflags;
  sv.max_edicts = saved.maxEdicts;
  sv.model_precache = saved.modelPrecache;
  svs.spawncount = saved.spawncount;
  svState.host_client = saved.hostClient;
  max_edicts.string = saved.maxEdictsCvar;
  max_edicts.value = Number(saved.maxEdictsCvar);
  net_message.data = savedNetData;
  net_message.cursize = saved.netCursize;
  net_message.maxsize = saved.netMaxsize;
  msgState.readcount = saved.readcount;
  msgState.badread = saved.badread;
  Cmd_TokenizeString("");
  svResetPrecacheWarnings();
});

beforeEach(() => {
  sv.protocol = PROTOCOL_VERSION;
  sv.protocolflags = 0;
  svResetPrecacheWarnings();
});

function msgBuf(size = 4096): SizeBuf {
  const sb = new SizeBuf();
  sb.data = new Uint8Array(size);
  sb.maxsize = size;
  sb.cursize = 0;
  return sb;
}

//============================================================================

describe("the QuakeWorld edict table is the shared max_edicts", () => {
  test("qwProfile.maxEdicts is the table SV_SpawnServer allocated", () => {
    sv.max_edicts = 4096;
    expect(qwProfile.maxEdicts).toBe(4096);
    sv.max_edicts = 0;
  });

  // `max_edicts` is registered by Host_Init (WinQuake) and by qwsv's SV_Init;
  // neither has run in this process, so Cvar_Set would not find it. Its two
  // fields are what Cvar_RegisterVariable would have set, written directly
  // and put back in afterAll.
  function setMaxEdicts(v: number): void {
    max_edicts.string = String(v);
    max_edicts.value = v;
  }

  test("with no server allocated yet it is the clamped cvar, exactly what SV_SpawnServer would allocate", () => {
    sv.max_edicts = 0;
    setMaxEdicts(1024);
    expect(qwProfile.maxEdicts).toBe(1024);
    expect(qwProfile.maxEdicts).toBe(Host_MaxEdicts());
  });

  test("and it is no longer pinned to QuakeWorld's bothdefs.h 768", () => {
    sv.max_edicts = 0;
    setMaxEdicts(16384);
    expect(qwProfile.maxEdicts).toBe(16384);
    expect(qwProfile.maxEdicts).toBeGreaterThan(768);
  });
});

describe("protocol 28's 512-entity limit is the wire's, not the server's", () => {
  function delta(number: number): SizeBuf {
    const from = new QwEntityStateT();
    from.number = number;
    const to = new QwEntityStateT();
    to.number = number;
    to.frame = 7; // one changed field, so there is something to send

    const msg = msgBuf();
    SV_WriteDelta(from, to, msg, true);
    return msg;
  }

  test("an entity below it is sent on 28", () => {
    expect(delta(511).cursize).toBeGreaterThan(0);
  });

  test("an entity at or above it is dropped on 28 -- no bytes, and no SV_Error", () => {
    expect(qw28Codec.maxEntityNumber).toBe(512);
    expect(delta(512).cursize).toBe(0);
    expect(delta(5000).cursize).toBe(0);
  });

  test("the same entity is sent on 29", () => {
    sv.protocol = PROTOCOL_QW_WIDE;
    sv.protocolflags = qw29Codec.defaultFlags;
    expect(qw29Codec.maxEntityNumber).toBe(65536);
    expect(delta(5000).cursize).toBeGreaterThan(0);
    expect(delta(65535).cursize).toBeGreaterThan(0);
    expect(delta(65536).cursize).toBe(0);
  });
});

describe("svc_modellist stops where the protocol's index does", () => {
  // Reads back one svc_modellist message: the leading count, every name, and
  // the trailing "next index".
  function parseModellist(msg: SizeBuf, wide: boolean): { first: number; names: string[]; next: number } {
    net_message.data = msg.data.subarray(0, msg.cursize);
    net_message.cursize = msg.cursize;
    net_message.maxsize = msg.cursize;
    MSG_BeginReading();

    expect(MSG_ReadByte()).toBe(SvcOpsT.svc_modellist);
    const first = wide ? MSG_ReadShort() & 0xffff : MSG_ReadByte();
    const names: string[] = [];
    for (;;) {
      const s = MSG_ReadString();
      if (s === "") break;
      names.push(s);
    }
    const next = wide ? MSG_ReadShort() & 0xffff : MSG_ReadByte();
    return { first, names, next };
  }

  function runModellist(from: number): SizeBuf {
    const client = new ClientT();
    client.state = ClientStateT.cs_connected;
    client.netchan.message = msgBuf(MAX_MSGLEN * 4);
    svState.host_client = client;

    svs.spawncount = 42;
    // Short names so the MAX_MSGLEN/2 stop is never what ends the list.
    const table: Array<string | null> = new Array<string | null>(400).fill(null);
    table[0] = "";
    for (let i = 1; i < 400; i++) table[i] = `m${i}`;
    sv.model_precache = table;

    Cmd_TokenizeString(`modellist 42 ${from}`);
    SV_Modellist_f();
    return client.netchan.message;
  }

  test("protocol 28 names index 255 and stops there", () => {
    expect(qw28Codec.maxPrecache).toBe(256);
    const parsed = parseModellist(runModellist(250), false);
    expect(parsed.first).toBe(250);
    // indices 251..255, then the wire runs out of byte
    expect(parsed.names).toEqual(["m251", "m252", "m253", "m254", "m255"]);
    expect(parsed.next).toBe(0); // nothing more this protocol can name
  });

  test("protocol 29 carries on past 255, with short counts", () => {
    sv.protocol = PROTOCOL_QW_WIDE;
    sv.protocolflags = qw29Codec.defaultFlags;
    expect(qw29Codec.maxPrecache).toBe(8192);

    const parsed = parseModellist(runModellist(250), true);
    expect(parsed.first).toBe(250);
    expect(parsed.names.length).toBeGreaterThan(5);
    expect(parsed.names).toContain("m256");
    expect(parsed.names).toContain("m300");
  });
});

describe("sv_qwprotocol auto's entity count", () => {
  test("SV_CountQwEntityLump counts top-level blocks and ignores braces inside strings", () => {
    expect(SV_CountQwEntityLump("")).toBe(0);
    expect(SV_CountQwEntityLump('{\n"classname" "worldspawn"\n}\n')).toBe(1);
    expect(SV_CountQwEntityLump('{\n"a" "b"\n}\n{\n"c" "d"\n}\n')).toBe(2);
    expect(SV_CountQwEntityLump('{\n"message" "a { brace }"\n}\n')).toBe(1);
  });
});
