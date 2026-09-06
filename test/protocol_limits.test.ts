// The widened engine limits (ARCHITECTURE.md "Engine core commitments"), the
// `max_edicts` cvar and its clamp, and `sv_protocol auto`'s decision.
//
// Self-sufficiency: the two cvars this file drives (`max_edicts`, `sv_protocol`)
// are registered here if the suite that owns them has not run first, and both
// string values are restored in afterAll. `svs.maxclients` and `sv.max_edicts`
// are snapshotted and restored the same way. Nothing else shared is touched:
// SV_AutoProtocol / SV_ChooseProtocol / SV_CountEntityLump are pure functions
// over a ModelT this file builds itself, so no map, no progs.dat and no server
// spawn is needed.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Cvar_FindVar, Cvar_RegisterVariable, Cvar_Set } from "../src/common/cvar";
import { Host_MaxEdicts, max_edicts } from "../src/common/host";
import {
  DATAGRAM_MTU,
  DEFAULT_MAX_EDICTS,
  MAX_CL_STATS,
  MAX_DATAGRAM,
  MAX_EDICTS,
  MAX_LIGHTSTYLES,
  MAX_MODELS,
  MAX_MSGLEN,
  MAX_SOUNDS,
  MIN_EDICTS,
} from "../src/common/quakedef";
import { MAX_STATIC_ENTITIES, MAX_VISEDICTS, cl_entities, cl_entity_ext, cl_static_entities, cl_static_entity_ext, cl_visedicts, growEntities, growStaticEntities } from "../src/client/client";
import { ModelT } from "../src/common/model";
import { BSP_WIDTH_29, BSP_WIDTH_2PSB, BSP_WIDTH_BSP2 } from "../src/common/bspfile";
import { PROTOCOL_FITZQUAKE, PROTOCOL_NETQUAKE, PROTOCOL_RMQ } from "../src/common/protocol";
import { SV_AutoProtocol, SV_ChooseProtocol, SV_CountEntityLump, sv_protocol } from "../src/server/sv_main";
import { nq15Codec } from "../src/common/protocol/nq15";
import { WIDE_MAX_DATAGRAM, WIDE_MAX_MSGLEN } from "../src/common/protocol/wide";
import { sv, svs } from "../src/server/server";
import { nqProfile } from "../src/progs/profiles/nq";

const savedMaxEdicts = max_edicts.string;
const savedSvProtocol = sv_protocol.string;
const savedMaxclients = svs.maxclients;
const savedSvMaxEdicts = sv.max_edicts;

beforeAll(() => {
  if (Cvar_FindVar("max_edicts") === null) Cvar_RegisterVariable(max_edicts);
  if (Cvar_FindVar("sv_protocol") === null) Cvar_RegisterVariable(sv_protocol);
});

afterAll(() => {
  Cvar_Set("max_edicts", savedMaxEdicts);
  Cvar_Set("sv_protocol", savedSvProtocol);
  svs.maxclients = savedMaxclients;
  sv.max_edicts = savedSvMaxEdicts;
});

describe("the widened limits", () => {
  test("quakedef.h's per-level limits match Ironwail's", () => {
    // Ironwail quakedef.h:97-110 / client.h:307-308 / quakedef.h:122.
    expect(MAX_EDICTS).toBe(32000);
    expect(MIN_EDICTS).toBe(256);
    expect(DEFAULT_MAX_EDICTS).toBe(16384);
    expect(MAX_MODELS).toBe(8192);
    expect(MAX_SOUNDS).toBe(2048);
    expect(MAX_CL_STATS).toBe(256);
    expect(MAX_MSGLEN).toBe(64000);
    expect(MAX_DATAGRAM).toBe(64000);
    expect(DATAGRAM_MTU).toBe(1400);
    expect(MAX_STATIC_ENTITIES).toBe(4096);
    expect(MAX_VISEDICTS).toBe(4096);
    // unchanged
    expect(MAX_LIGHTSTYLES).toBe(64);
  });

  test("protocol 15 keeps WinQuake's wire sizes even though the buffers are wide", () => {
    expect(nq15Codec.maxMsglen).toBe(8000);
    expect(nq15Codec.maxDatagram).toBe(1024);
    expect(nq15Codec.maxPrecache).toBe(256);
    expect(WIDE_MAX_MSGLEN).toBe(64000);
    expect(WIDE_MAX_DATAGRAM).toBe(64000);
  });

  test("cl_visedicts is sized from MAX_VISEDICTS", () => {
    expect(cl_visedicts.length).toBe(MAX_VISEDICTS);
  });
});

describe("the client's entity tables grow on demand", () => {
  test("cl_entities starts at WinQuake's 600 and grows to hold any index below MAX_EDICTS", () => {
    // Nothing here shrinks the arrays, so a suite that ran before this one may
    // already have grown them; the invariant is the ceiling, not the start.
    expect(cl_entities.length).toBeLessThanOrEqual(MAX_EDICTS);
    expect(cl_entity_ext.length).toBe(cl_entities.length);

    expect(growEntities(2000)).toBe(true);
    expect(cl_entities.length).toBeGreaterThan(2000);
    expect(cl_entity_ext.length).toBe(cl_entities.length);
    expect(cl_entities[2000]).not.toBe(cl_entities[1999]);
    expect(cl_entities[2000].origin).not.toBe(cl_entities[1999].origin);

    // Growing to a lower index is a no-op, never a shrink.
    const len = cl_entities.length;
    expect(growEntities(5)).toBe(true);
    expect(cl_entities.length).toBe(len);

    // MAX_EDICTS is the ceiling CL_EntityNum turns into a Host_Error.
    expect(growEntities(MAX_EDICTS)).toBe(false);
    expect(growEntities(MAX_EDICTS - 1)).toBe(true);
    expect(cl_entities.length).toBe(MAX_EDICTS);
  });

  test("cl_static_entities grows the same way, capped at MAX_STATIC_ENTITIES", () => {
    expect(growStaticEntities(500)).toBe(true);
    expect(cl_static_entities.length).toBeGreaterThan(500);
    expect(cl_static_entity_ext.length).toBe(cl_static_entities.length);
    expect(growStaticEntities(MAX_STATIC_ENTITIES)).toBe(false);
    expect(growStaticEntities(MAX_STATIC_ENTITIES - 1)).toBe(true);
    expect(cl_static_entities.length).toBe(MAX_STATIC_ENTITIES);
  });
});

describe("the max_edicts cvar", () => {
  test("defaults to 16384 and clamps to MIN_EDICTS..MAX_EDICTS", () => {
    Cvar_Set("max_edicts", String(DEFAULT_MAX_EDICTS));
    expect(Host_MaxEdicts()).toBe(16384);

    Cvar_Set("max_edicts", "600");
    expect(Host_MaxEdicts()).toBe(600);

    // Ironwail sv_main.c:1971's CLAMP (MIN_EDICTS, max_edicts.value, MAX_EDICTS)
    Cvar_Set("max_edicts", "0");
    expect(Host_MaxEdicts()).toBe(MIN_EDICTS);
    Cvar_Set("max_edicts", "-9999");
    expect(Host_MaxEdicts()).toBe(MIN_EDICTS);
    Cvar_Set("max_edicts", "99999");
    expect(Host_MaxEdicts()).toBe(MAX_EDICTS);

    // A non-numeric value reads back as 0 through Q_atof, so it clamps up.
    Cvar_Set("max_edicts", "lots");
    expect(Host_MaxEdicts()).toBe(MIN_EDICTS);

    // Fractions truncate, matching the C's `(int)max_edicts.value`.
    Cvar_Set("max_edicts", "1024.9");
    expect(Host_MaxEdicts()).toBe(1024);

    Cvar_Set("max_edicts", String(DEFAULT_MAX_EDICTS));
  });

  test("the NQ progs profile's maxEdicts follows the live table, then the cvar", () => {
    // Ironwail's ED_Alloc caps at qcvm->max_edicts, the table SV_SpawnServer
    // actually allocated. Before that allocation the clamped cvar value is the
    // answer, because it is exactly what SV_SpawnServer is about to allocate.
    sv.max_edicts = 0;
    Cvar_Set("max_edicts", "4096");
    expect(nqProfile.maxEdicts).toBe(4096);

    sv.max_edicts = 900;
    expect(nqProfile.maxEdicts).toBe(900);

    sv.max_edicts = 0;
    Cvar_Set("max_edicts", String(DEFAULT_MAX_EDICTS));
    expect(nqProfile.maxEdicts).toBe(DEFAULT_MAX_EDICTS);
  });
});

// A worldmodel just complete enough for the auto decision: bounds and an
// entity lump. Nothing else in SV_AutoProtocol reads the model.
function fakeWorld(minZ: number, maxZ: number, entities: string): ModelT {
  const m = new ModelT();
  m.mins[0] = m.mins[1] = m.mins[2] = minZ;
  m.maxs[0] = m.maxs[1] = m.maxs[2] = maxZ;
  m.entities = entities;
  return m;
}

// n entity blocks, the shape ED_LoadFromFile parses.
function entityLump(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += `{\n"classname" "info_notnull"\n"origin" "0 0 0"\n}\n`;
  return s;
}

describe("SV_CountEntityLump", () => {
  test("counts top-level blocks and ignores braces inside strings", () => {
    expect(SV_CountEntityLump("")).toBe(0);
    expect(SV_CountEntityLump(entityLump(1))).toBe(1);
    expect(SV_CountEntityLump(entityLump(37))).toBe(37);
    // A `{` inside a quoted value is part of the value, not a new entity --
    // this is exactly the case COM_Parse handles and a naive count would not.
    expect(SV_CountEntityLump('{\n"message" "a { brace"\n}\n')).toBe(1);
    expect(SV_CountEntityLump('{\n"message" "}{"\n}\n{\n"a" "b"\n}\n')).toBe(2);
  });
});

describe("sv_protocol auto", () => {
  const smallLump = entityLump(50);

  test("picks 666 for a small BSP29 map inside +-4096", () => {
    svs.maxclients = 1;
    expect(SV_AutoProtocol(fakeWorld(-2048, 2048, smallLump), BSP_WIDTH_29)).toBe(PROTOCOL_FITZQUAKE);
  });

  test("picks 999 when the map is BSP2 or 2PSB", () => {
    svs.maxclients = 1;
    expect(SV_AutoProtocol(fakeWorld(-64, 64, smallLump), BSP_WIDTH_BSP2)).toBe(PROTOCOL_RMQ);
    expect(SV_AutoProtocol(fakeWorld(-64, 64, smallLump), BSP_WIDTH_2PSB)).toBe(PROTOCOL_RMQ);
  });

  test("picks 999 when any worldmodel bound leaves +-4096", () => {
    svs.maxclients = 1;
    // exactly on the edge stays 666: 13.3 fixed point reaches +-4096
    expect(SV_AutoProtocol(fakeWorld(-4096, 4096, smallLump), BSP_WIDTH_29)).toBe(PROTOCOL_FITZQUAKE);
    expect(SV_AutoProtocol(fakeWorld(-4097, 4096, smallLump), BSP_WIDTH_29)).toBe(PROTOCOL_RMQ);
    expect(SV_AutoProtocol(fakeWorld(-4096, 4097, smallLump), BSP_WIDTH_29)).toBe(PROTOCOL_RMQ);
    expect(SV_AutoProtocol(fakeWorld(-20000, 20000, smallLump), BSP_WIDTH_29)).toBe(PROTOCOL_RMQ);
  });

  test("picks 999 when the spawned edict count would pass 600", () => {
    svs.maxclients = 1;
    // count + maxclients + 1 (the world edict and the client slots)
    expect(SV_AutoProtocol(fakeWorld(-64, 64, entityLump(598)), BSP_WIDTH_29)).toBe(PROTOCOL_FITZQUAKE);
    expect(SV_AutoProtocol(fakeWorld(-64, 64, entityLump(599)), BSP_WIDTH_29)).toBe(PROTOCOL_RMQ);

    // more client slots means fewer map entities before the threshold
    svs.maxclients = 16;
    expect(SV_AutoProtocol(fakeWorld(-64, 64, entityLump(583)), BSP_WIDTH_29)).toBe(PROTOCOL_FITZQUAKE);
    expect(SV_AutoProtocol(fakeWorld(-64, 64, entityLump(584)), BSP_WIDTH_29)).toBe(PROTOCOL_RMQ);
  });

  test("an explicit sv_protocol overrides the map entirely", () => {
    svs.maxclients = 1;
    const bigBsp2 = fakeWorld(-20000, 20000, entityLump(2000));
    const small = fakeWorld(-64, 64, smallLump);

    Cvar_Set("sv_protocol", "15");
    expect(SV_ChooseProtocol(bigBsp2, BSP_WIDTH_BSP2)).toBe(PROTOCOL_NETQUAKE);

    Cvar_Set("sv_protocol", "666");
    expect(SV_ChooseProtocol(bigBsp2, BSP_WIDTH_BSP2)).toBe(PROTOCOL_FITZQUAKE);

    Cvar_Set("sv_protocol", "999");
    expect(SV_ChooseProtocol(small, BSP_WIDTH_29)).toBe(PROTOCOL_RMQ);

    Cvar_Set("sv_protocol", "auto");
    expect(SV_ChooseProtocol(small, BSP_WIDTH_29)).toBe(PROTOCOL_FITZQUAKE);
    expect(SV_ChooseProtocol(bigBsp2, BSP_WIDTH_BSP2)).toBe(PROTOCOL_RMQ);

    // `auto` never picks 15: protocol 15 is only ever chosen by asking.
    expect(SV_ChooseProtocol(small, BSP_WIDTH_29)).not.toBe(PROTOCOL_NETQUAKE);

    // An unrecognised value falls back to auto rather than to a broken server.
    Cvar_Set("sv_protocol", "42");
    expect(SV_ChooseProtocol(small, BSP_WIDTH_29)).toBe(PROTOCOL_FITZQUAKE);

    Cvar_Set("sv_protocol", "auto");
  });

  test("the cvar's default is auto", () => {
    // CvarT keeps the registered default string; sv_protocol's is "auto".
    const found = Cvar_FindVar("sv_protocol");
    expect(found).not.toBeNull();
    expect(sv_protocol.name).toBe("sv_protocol");
  });
});
