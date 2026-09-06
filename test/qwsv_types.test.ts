import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { SysError } from "../src/platform/sys";
import { QuakeParmsT } from "../src/qw/server/qwsvdef";
import {
  PROGHEADER_CRC,
  QW_ENTVARS_OFS,
  QW_ENTVARS_SIZE_WORDS,
  QW_GLOBAL_OFS,
  QW_NUM_GLOBAL_WORDS,
  QwEntVars,
  QwGlobalVars,
} from "../src/qw/server/progdefs";
import {
  EDICT_NUM,
  EDICT_TO_PROG,
  LinkT,
  MAX_ENT_LEAFS,
  MAX_PRSTR,
  NUM_FOR_EDICT,
  PROG_TO_EDICT,
  ENGINE_STRING_BASE,
  PR_ClearEngineStrings,
  PR_GetString,
  PR_SetString,
  QwEdictT,
  qwpr,
  setEdictTable,
} from "../src/qw/server/progs";
import {
  ClientFrameT,
  ClientStateT,
  ClientT,
  MAX_CHALLENGES,
  MulticastT,
  RedirectT,
  ServerStateT,
  ServerStaticT,
  ServerT,
  sv,
  svs,
  svState,
} from "../src/qw/server/server";
import { MAX_CLIENTS, UPDATE_BACKUP } from "../src/qw/protocol";

const qwprogsPath = `${process.env.Q1TS_QSRC ?? `${import.meta.dir}/../../qsrc/quake`}/QW/progs/qwprogs.dat`;

describe("progdefs.ts (QW)", () => {
  test("PROGHEADER_CRC matches the retail qwprogs.dat header word", () => {
    expect(PROGHEADER_CRC).toBe(54730);

    if (!existsSync(qwprogsPath)) return; // fixture not present on this machine
    const data = readFileSync(qwprogsPath);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const version = view.getInt32(0, true);
    const crc = view.getInt32(4, true);
    expect(version).toBe(6);
    expect(crc).toBe(PROGHEADER_CRC);
  });

  test("QW_GLOBAL_OFS: pad[28] precedes self/other/world; newmis is QW's added field, deathmatch/coop/teamplay are gone", () => {
    expect(QW_GLOBAL_OFS.self).toBe(28);
    expect(QW_GLOBAL_OFS.other).toBe(29);
    expect(QW_GLOBAL_OFS.world).toBe(30);
    expect(QW_GLOBAL_OFS.time).toBe(31); // first float field, right after world
    expect(QW_GLOBAL_OFS.frametime).toBe(32);
    expect(QW_GLOBAL_OFS.newmis).toBe(33); // QW-only int field, not in WinQuake's globalvars_t
    expect(QW_GLOBAL_OFS.force_retouch).toBe(34);
    expect(QW_GLOBAL_OFS.mapname).toBe(35);
    // WinQuake has deathmatch/coop/teamplay here (3 words); QW drops all three,
    // so serverflags sits right after mapname instead of 3 words later.
    expect(QW_GLOBAL_OFS.serverflags).toBe(36);
    expect(QW_GLOBAL_OFS.parm1).toBe(41);
    expect(QW_GLOBAL_OFS.parm16).toBe(56); // 16 parms, 41..56
    expect(QW_GLOBAL_OFS.v_forward).toBe(57); // first vec3 after parm16
    expect(QW_GLOBAL_OFS.v_up).toBe(60); // v_forward + 3
    expect(QW_GLOBAL_OFS.v_right).toBe(63);
    expect(QW_GLOBAL_OFS.trace_endpos).toBe(69);
    expect(QW_GLOBAL_OFS.trace_plane_normal).toBe(72);
    expect(QW_GLOBAL_OFS.trace_ent).toBe(76);
    expect(QW_GLOBAL_OFS.msg_entity).toBe(79);
    expect(QW_GLOBAL_OFS.main).toBe(80); // first function pointer
    expect(QW_GLOBAL_OFS.SetChangeParms).toBe(89); // last field
    expect(QW_NUM_GLOBAL_WORDS).toBe(90); // WinQuake's 92, -3 (deathmatch/coop/teamplay) +1 (newmis)
  });

  test("QW_ENTVARS_OFS: modelindex at 0; lastruntime is QW's added field, punchangle/idealpitch are gone", () => {
    expect(QW_ENTVARS_OFS.modelindex).toBe(0);
    expect(QW_ENTVARS_OFS.absmin).toBe(1);
    expect(QW_ENTVARS_OFS.absmax).toBe(4);
    expect(QW_ENTVARS_OFS.ltime).toBe(7);
    expect(QW_ENTVARS_OFS.lastruntime).toBe(8); // QW-only field, not in WinQuake's entvars_t
    expect(QW_ENTVARS_OFS.movetype).toBe(9);
    expect(QW_ENTVARS_OFS.solid).toBe(10);
    expect(QW_ENTVARS_OFS.origin).toBe(11);
    expect(QW_ENTVARS_OFS.oldorigin).toBe(14); // origin + 3
    // WinQuake has punchangle (vec3, 3 words) between avelocity and classname;
    // QW drops it, so classname sits 3 words earlier than WinQuake's offset.
    expect(QW_ENTVARS_OFS.classname).toBe(26);
    expect(QW_ENTVARS_OFS.model).toBe(27);
    expect(QW_ENTVARS_OFS.mins).toBe(31);
    expect(QW_ENTVARS_OFS.touch).toBe(40); // after mins/maxs/size (9 words) from 31
    expect(QW_ENTVARS_OFS.nextthink).toBe(44);
    expect(QW_ENTVARS_OFS.view_ofs).toBe(60);
    // WinQuake has idealpitch (float) between v_angle and netname; QW drops it.
    expect(QW_ENTVARS_OFS.v_angle).toBe(68);
    expect(QW_ENTVARS_OFS.netname).toBe(71);
    expect(QW_ENTVARS_OFS.movedir).toBe(93);
    expect(QW_ENTVARS_OFS.message).toBe(96); // movedir + 3
    expect(QW_ENTVARS_OFS.noise3).toBe(101); // last field
    expect(QW_ENTVARS_SIZE_WORDS).toBe(102); // WinQuake's 105, +1 (lastruntime) -3 (punchangle) -1 (idealpitch)
  });

  test("QwGlobalVars getters/setters round-trip through the shared f/i arrays", () => {
    const f = new Float32Array(QW_NUM_GLOBAL_WORDS);
    const i = new Int32Array(f.buffer);
    const g = new QwGlobalVars(f, i);

    g.self = 3;
    expect(i[QW_GLOBAL_OFS.self]).toBe(3);
    i[QW_GLOBAL_OFS.other] = 7;
    expect(g.other).toBe(7);

    g.newmis = 5;
    expect(i[QW_GLOBAL_OFS.newmis]).toBe(5);

    g.time = 12.5;
    expect(f[QW_GLOBAL_OFS.time]).toBeCloseTo(12.5);
    f[QW_GLOBAL_OFS.serverflags] = 1;
    expect(g.serverflags).toBe(1);

    // vector fields are persistent subarray views, not copies
    g.v_forward[0] = 1;
    g.v_forward[1] = 0;
    g.v_forward[2] = 0;
    expect(f[QW_GLOBAL_OFS.v_forward]).toBe(1);
    expect(Array.from(g.v_forward)).toEqual([1, 0, 0]);

    g.main = 42;
    expect(i[QW_GLOBAL_OFS.main]).toBe(42);
  });

  test("QwEntVars getters/setters round-trip; origin is a persistent Vec3 view", () => {
    const f = new Float32Array(QW_ENTVARS_SIZE_WORDS);
    const i = new Int32Array(f.buffer);
    const ev = new QwEntVars(f, i);

    ev.health = 100;
    expect(f[QW_ENTVARS_OFS.health]).toBe(100);

    ev.lastruntime = 4.5;
    expect(f[QW_ENTVARS_OFS.lastruntime]).toBeCloseTo(4.5);

    ev.classname = 55; // string_t offset
    expect(i[QW_ENTVARS_OFS.classname]).toBe(55);

    ev.origin[1] = 64;
    expect(f[QW_ENTVARS_OFS.origin + 1]).toBe(64);

    f[QW_ENTVARS_OFS.solid] = 2;
    expect(ev.solid).toBe(2);

    ev.owner = 9; // int/entity field
    expect(i[QW_ENTVARS_OFS.owner]).toBe(9);
  });
});

describe("progs.ts (QW)", () => {
  test("MAX_ENT_LEAFS and LinkT are re-exported unchanged from src/progs/progs.ts", () => {
    expect(MAX_ENT_LEAFS).toBe(16);
    expect(new LinkT().prev).toBeNull();
    expect(new LinkT().owner).toBeNull();
  });

  test("QwEdictT constructor allocates entityfields words and v views the head of the block", () => {
    const entityfields = QW_ENTVARS_SIZE_WORDS + 50; // entvars_t plus some QuakeC fields
    const ed = new QwEdictT(3, entityfields);

    expect(ed.index).toBe(3);
    expect(ed.free).toBe(false);
    expect(ed.leafnums.length).toBe(MAX_ENT_LEAFS);
    expect(ed.fields.f.length).toBe(entityfields);
    expect(ed.fields.i.length).toBe(entityfields);
    expect(ed.area).toBeInstanceOf(LinkT);
    // Task 3 (2026-09-05): LinkT.owner is now EdictT | QwEdictT | null, so
    // QwEdictT's constructor sets area.owner = this, the same as EdictT's
    // does -- see src/progs/progs.ts's file header.
    expect(ed.area.owner).toBe(ed);

    // v is a view over the head of the same buffer entvars_t occupies
    ed.v.health = 75;
    expect(ed.fields.f[QW_ENTVARS_OFS.health]).toBe(75);
    ed.fields.i[QW_ENTVARS_OFS.owner] = 11;
    expect(ed.v.owner).toBe(11);

    // fields beyond entvars_t (QuakeC-declared) are reachable through the
    // same buffer, past QW_ENTVARS_SIZE_WORDS
    ed.fields.f[QW_ENTVARS_SIZE_WORDS] = 3.5;
    expect(ed.fields.f[QW_ENTVARS_SIZE_WORDS]).toBeCloseTo(3.5);

    // baseline is QW's own entity_state_t (protocol.ts), not the NQ one
    expect(ed.baseline.number).toBe(0);
  });

  test("EDICT_NUM/NUM_FOR_EDICT/PROG_TO_EDICT/EDICT_TO_PROG are index round-trips over the registered table", () => {
    const entityfields = QW_ENTVARS_SIZE_WORDS;
    const edicts = [new QwEdictT(0, entityfields), new QwEdictT(1, entityfields), new QwEdictT(2, entityfields)];
    setEdictTable(edicts);

    expect(EDICT_NUM(1)).toBe(edicts[1]);
    expect(NUM_FOR_EDICT(edicts[2])).toBe(2);
    expect(PROG_TO_EDICT(0)).toBe(edicts[0]);
    expect(EDICT_TO_PROG(edicts[2])).toBe(2);

    expect(() => EDICT_NUM(-1)).toThrow(SysError);
    expect(() => EDICT_NUM(3)).toThrow(SysError);
  });

  test("PR_SetString/PR_GetString round-trip and dedup by content (MAX_PRSTR bound enforced)", () => {
    PR_ClearEngineStrings();
    expect(MAX_PRSTR).toBe(1024);

    const a = PR_SetString("player");
    const b = PR_SetString("world");
    const aAgain = PR_SetString("player");

    // positive, based at ENGINE_STRING_BASE, for the NaN-canonicalisation
    // reason src/qw/server/progs.ts's header documents
    expect(a).toBeGreaterThanOrEqual(ENGINE_STRING_BASE);
    expect(b).toBeGreaterThanOrEqual(ENGINE_STRING_BASE);
    expect(a).not.toBe(b);
    expect(aAgain).toBe(a); // deduplicated by content, not a fresh index

    expect(PR_GetString(a)).toBe("player");
    expect(PR_GetString(b)).toBe("world");

    expect(() => PR_GetString(a + 1000)).toThrow(SysError);
    expect(() => PR_GetString(-1)).toThrow(SysError);

    PR_ClearEngineStrings();
  });

  test("PR_GetString on a progs string block reads to the first NUL", () => {
    const bytes = new Uint8Array([0, ...Array.from("hello", (c) => c.charCodeAt(0)), 0, 0x41, 0x42, 0]);
    qwpr.strings = bytes;

    expect(PR_GetString(0)).toBe("");
    expect(PR_GetString(1)).toBe("hello");
    expect(PR_GetString(7)).toBe("AB");

    qwpr.strings = null;
  });
});

describe("server.ts (QW)", () => {
  test("QuakeParmsT re-export from qwsvdef.ts is usable", () => {
    const parms = new QuakeParmsT();
    expect(parms.basedir).toBe("");
    expect(parms.argc).toBe(0);
  });

  test("ServerStateT / ClientStateT / MulticastT / RedirectT match the C enum order", () => {
    expect(ServerStateT.ss_dead).toBe(0);
    expect(ServerStateT.ss_loading).toBe(1);
    expect(ServerStateT.ss_active).toBe(2);

    expect(ClientStateT.cs_free).toBe(0);
    expect(ClientStateT.cs_zombie).toBe(1);
    expect(ClientStateT.cs_connected).toBe(2);
    expect(ClientStateT.cs_spawned).toBe(3);

    expect(MulticastT.MULTICAST_ALL).toBe(0);
    expect(MulticastT.MULTICAST_PVS_R).toBe(5);

    expect(RedirectT.RD_NONE).toBe(0);
    expect(RedirectT.RD_CLIENT).toBe(1);
    expect(RedirectT.RD_PACKET).toBe(2);
  });

  test("sv defaults to a fresh ServerT, ss_dead, no worldmodel, empty edicts", () => {
    const fresh = new ServerT();
    expect(fresh.state).toBe(ServerStateT.ss_dead);
    expect(fresh.active).toBe(false);
    expect(fresh.worldmodel).toBeNull();
    expect(fresh.num_edicts).toBe(0);
    expect(fresh.edicts).toEqual([]);
    expect(fresh.model_precache.length).toBeGreaterThan(0);
    expect(fresh.model_precache.every((m) => m === null)).toBe(true);

    // the module singleton itself is a ServerT too
    expect(sv).toBeInstanceOf(ServerT);
  });

  test("svs defaults to a fresh ServerStaticT with MAX_CLIENTS clients and MAX_CHALLENGES challenges", () => {
    const fresh = new ServerStaticT();
    expect(fresh.clients.length).toBe(MAX_CLIENTS);
    expect(fresh.clients.every((c) => c instanceof ClientT)).toBe(true);
    expect(fresh.clients[0].state).toBe(ClientStateT.cs_free);
    expect(fresh.challenges.length).toBe(MAX_CHALLENGES);
    expect(MAX_CHALLENGES).toBe(1024);

    expect(svs).toBeInstanceOf(ServerStaticT);
  });

  test("svState holder starts with null host_client/sv_player", () => {
    expect(svState.host_client).toBeNull();
    expect(svState.sv_player).toBeNull();
  });

  test("ClientT.frames has exactly UPDATE_BACKUP entries of ClientFrameT", () => {
    const c = new ClientT();
    expect(UPDATE_BACKUP).toBe(64);
    expect(c.frames.length).toBe(UPDATE_BACKUP);
    expect(c.frames.every((f) => f instanceof ClientFrameT)).toBe(true);
    expect(c.frames[0].entities.num_entities).toBe(0);
  });

  test("ClientT.netchan/snap_from are embedded values, not null pointers", () => {
    const c = new ClientT();
    expect(c.netchan.outgoing_sequence).toBe(0);
    expect(c.snap_from.port).toBe(0);
    expect(c.delta_sequence).toBe(-1); // -1 = no compression
  });
});
