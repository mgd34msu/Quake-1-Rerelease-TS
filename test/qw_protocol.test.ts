/*
Self-sufficient test for Q001: src/qw/protocol.ts, src/qw/bothdefs.ts, the
`qw.active` flag, and the QW additions to src/client/client.ts and
src/common/cvar.ts.

Values below are spot-checked directly against QW/client/protocol.h,
QW/client/bothdefs.h and QW/client/client.h (see each file's own header for
the exact source lines).
*/

import { describe, expect, test } from "bun:test";

import { qw } from "../src/common/quakedef";
import { CvarT } from "../src/common/cvar";
import { CactiveT, cl, ClientStateT, cls } from "../src/client/client";
import { QwClientStateExtT, QwClientStaticExtT } from "../src/qw/client/client";
import {
  CM_ANGLE1,
  CM_ANGLE2,
  CM_ANGLE3,
  CM_BUTTONS,
  CM_FORWARD,
  CM_IMPULSE,
  CM_SIDE,
  CM_UP,
  ClcOpsT,
  MAX_CLIENTS,
  PF_COMMAND,
  PF_DEAD,
  PF_GIB,
  PF_MSEC,
  PF_NOGRAV,
  PROTOCOL_VERSION,
  SvcOpsT,
  UPDATE_BACKUP,
  UPDATE_MASK,
  U_ANGLE1,
  U_MODEL,
  U_MOREBITS,
  U_ORIGIN1,
  U_SOLID,
} from "../src/qw/protocol";
import { MAX_DATAGRAM, MAX_EDICTS, MAX_MSGLEN, VERSION } from "../src/qw/bothdefs";

describe("QW protocol.h spot checks", () => {
  test("PROTOCOL_VERSION is 28", () => {
    expect(PROTOCOL_VERSION).toBe(28);
  });

  test("svc_* values match the header", () => {
    expect(SvcOpsT.svc_bad).toBe(0);
    expect(SvcOpsT.svc_updatestat).toBe(3);
    expect(SvcOpsT.svc_setview).toBe(5);
    expect(SvcOpsT.svc_sound).toBe(6);
    expect(SvcOpsT.svc_print).toBe(8);
    expect(SvcOpsT.svc_stufftext).toBe(9);
    expect(SvcOpsT.svc_setangle).toBe(10);
    expect(SvcOpsT.svc_serverdata).toBe(11);
    expect(SvcOpsT.svc_lightstyle).toBe(12);
    expect(SvcOpsT.svc_updatefrags).toBe(14);
    expect(SvcOpsT.svc_stopsound).toBe(16);
    expect(SvcOpsT.svc_damage).toBe(19);
    expect(SvcOpsT.svc_spawnstatic).toBe(20);
    expect(SvcOpsT.svc_spawnbaseline).toBe(22);
    expect(SvcOpsT.svc_temp_entity).toBe(23);
    expect(SvcOpsT.svc_centerprint).toBe(26);
    expect(SvcOpsT.svc_killedmonster).toBe(27);
    expect(SvcOpsT.svc_foundsecret).toBe(28);
    expect(SvcOpsT.svc_spawnstaticsound).toBe(29);
    expect(SvcOpsT.svc_intermission).toBe(30);
    expect(SvcOpsT.svc_finale).toBe(31);
    expect(SvcOpsT.svc_cdtrack).toBe(32);
    expect(SvcOpsT.svc_smallkick).toBe(34);
    expect(SvcOpsT.svc_bigkick).toBe(35);
    expect(SvcOpsT.svc_updateping).toBe(36);
    expect(SvcOpsT.svc_updateentertime).toBe(37);
    expect(SvcOpsT.svc_updatestatlong).toBe(38);
    expect(SvcOpsT.svc_muzzleflash).toBe(39);
    expect(SvcOpsT.svc_updateuserinfo).toBe(40);
    expect(SvcOpsT.svc_download).toBe(41);
    expect(SvcOpsT.svc_playerinfo).toBe(42);
    expect(SvcOpsT.svc_nails).toBe(43);
    expect(SvcOpsT.svc_chokecount).toBe(44);
    expect(SvcOpsT.svc_modellist).toBe(45);
    expect(SvcOpsT.svc_soundlist).toBe(46);
    expect(SvcOpsT.svc_packetentities).toBe(47);
    expect(SvcOpsT.svc_deltapacketentities).toBe(48);
    expect(SvcOpsT.svc_maxspeed).toBe(49);
    expect(SvcOpsT.svc_entgravity).toBe(50);
    expect(SvcOpsT.svc_setinfo).toBe(51);
    expect(SvcOpsT.svc_serverinfo).toBe(52);
    expect(SvcOpsT.svc_updatepl).toBe(53);
  });

  test("clc_* values match the header", () => {
    expect(ClcOpsT.clc_bad).toBe(0);
    expect(ClcOpsT.clc_nop).toBe(1);
    expect(ClcOpsT.clc_move).toBe(3);
    expect(ClcOpsT.clc_stringcmd).toBe(4);
    expect(ClcOpsT.clc_delta).toBe(5);
    expect(ClcOpsT.clc_tmove).toBe(6);
    expect(ClcOpsT.clc_upload).toBe(7);
  });

  test("PF_* values match the header", () => {
    expect(PF_MSEC).toBe(1 << 0);
    expect(PF_COMMAND).toBe(1 << 1);
    expect(PF_DEAD).toBe(1 << 9);
    expect(PF_GIB).toBe(1 << 10);
    expect(PF_NOGRAV).toBe(1 << 11);
  });

  test("CM_* values match the header", () => {
    expect(CM_ANGLE1).toBe(1 << 0);
    expect(CM_ANGLE3).toBe(1 << 1);
    expect(CM_FORWARD).toBe(1 << 2);
    expect(CM_SIDE).toBe(1 << 3);
    expect(CM_UP).toBe(1 << 4);
    expect(CM_BUTTONS).toBe(1 << 5);
    expect(CM_IMPULSE).toBe(1 << 6);
    expect(CM_ANGLE2).toBe(1 << 7);
  });

  test("U_* values match the header (two distinct bytes)", () => {
    expect(U_ORIGIN1).toBe(1 << 9);
    expect(U_MOREBITS).toBe(1 << 15);
    // the "MOREBITS" extension byte reuses bits 0-6 with different meanings
    expect(U_ANGLE1).toBe(1 << 0);
    expect(U_MODEL).toBe(1 << 2);
    expect(U_SOLID).toBe(1 << 6);
  });

  test("MAX_CLIENTS / UPDATE_BACKUP / UPDATE_MASK match the header", () => {
    expect(MAX_CLIENTS).toBe(32);
    expect(UPDATE_BACKUP).toBe(64);
    expect(UPDATE_MASK).toBe(63);
  });
});

describe("QW bothdefs.h spot checks", () => {
  test("value collisions take the QW value under the C name", () => {
    expect(MAX_MSGLEN).toBe(1450); // WinQuake: 8000
    expect(MAX_DATAGRAM).toBe(1450); // WinQuake: 1024
    expect(MAX_EDICTS).toBe(768); // WinQuake: 600
    expect(VERSION).toBe(2.4); // WinQuake: 1.09
  });
});

describe("qw.active runtime flag", () => {
  test("defaults to false", () => {
    expect(qw.active).toBe(false);
  });
});

describe("ClientStateT/ClientStaticT QW extension members", () => {
  test("cl.qw is a QwClientStateExtT with players/frames sized per the header", () => {
    const c = new ClientStateT();
    expect(c.qw).toBeInstanceOf(QwClientStateExtT);
    expect(c.qw.players.length).toBe(MAX_CLIENTS);
    expect(c.qw.frames.length).toBe(UPDATE_BACKUP);
  });

  test("the cl singleton carries the same shape", () => {
    expect(cl.qw).toBeInstanceOf(QwClientStateExtT);
    expect(cl.qw.players.length).toBe(MAX_CLIENTS);
    expect(cl.qw.frames.length).toBe(UPDATE_BACKUP);
  });

  test("cls.qw is present and is a QwClientStaticExtT", () => {
    expect(cls.qw).toBeInstanceOf(QwClientStaticExtT);
  });
});

describe("CactiveT (QuakeWorld appended values)", () => {
  test("WinQuake values are unchanged", () => {
    expect(CactiveT.ca_dedicated).toBe(0);
    expect(CactiveT.ca_disconnected).toBe(1);
    expect(CactiveT.ca_connected).toBe(2);
  });

  test("QW values are appended after ca_connected", () => {
    expect(CactiveT.ca_demostart).toBe(3);
    expect(CactiveT.ca_onserver).toBe(4);
    expect(CactiveT.ca_active).toBe(5);
  });
});

describe("CvarT.info (QuakeWorld track)", () => {
  test("an explicit info argument is independent of archive/server", () => {
    const v = new CvarT("x", "1", false, false, true);
    expect(v.archive).toBe(false);
    expect(v.server).toBe(false);
    expect(v.info).toBe(true);
  });

  test("archive/server booleans are unaffected by info", () => {
    const v = new CvarT("y", "1", true, true, true);
    expect(v.archive).toBe(true);
    expect(v.server).toBe(true);
    expect(v.info).toBe(true);
  });

  test("the no-info WinQuake constructor shape defaults info to false", () => {
    const v = new CvarT("z", "1");
    expect(v.archive).toBe(false);
    expect(v.server).toBe(false);
    expect(v.info).toBe(false);
  });
});
