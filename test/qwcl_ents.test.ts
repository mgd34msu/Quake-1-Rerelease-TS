/*
Self-sufficient test for Q020: src/qw/client/cl_ents.ts, cl_pred.ts, cl_cam.ts
and skin.ts (QW/client/cl_ents.c, cl_pred.c, cl_cam.c, skin.c).

Standing order 13/15: every shared singleton this file touches -- cl, cls (and
their `qw` extension objects), cl_dlights, clState.cl_numvisedicts, cl_visedicts,
pmove/movevars/pmState, net_message/msgState, parseState, and the QW cvars whose
`.value` is 0 until Cvar_RegisterVariable runs (this suite never registers them:
the two trees share one registry, so it sets `.value`/`.string` directly and
restores them in afterAll) -- is reset by this file's own beforeEach, and
com_searchpaths/com_modified are cleared before each test and restored in
afterAll exactly as test/qw_common.test.ts does, so a suite that ran earlier in
the same bun process cannot satisfy or break a lookup here.
*/

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

import { CactiveT, cl, cl_dlights, cl_visedicts, cls, clState, MAX_DLIGHTS, MAX_VISEDICTS } from "../src/client/client";
import { EntityT } from "../src/client/render";
import { cl_baselines, DownloadTypeT, PlayerInfoT, SkinT } from "../src/qw/client/client";
import {
  CL_AllocDlight,
  CL_ClearProjectiles,
  CL_DecayLights,
  CL_EmitEntities,
  CL_LinkProjectiles,
  CL_NewDlight,
  CL_ParseDelta,
  CL_ParsePacketEntities,
  CL_ParsePlayerinfo,
  CL_ParseProjectiles,
  CL_SetSolidEntities,
  CL_SetSolidPlayers,
  CL_SetUpPlayerPrediction,
  cl_projectiles,
  cl_visedicts_list,
  projState,
  visState,
} from "../src/qw/client/cl_ents";
import { CL_PredictMove, CL_PredictUsercmd, cl_nopred, cl_pushlatency } from "../src/qw/client/cl_pred";
import {
  autocam,
  Cam_DrawPlayer,
  Cam_DrawViewModel,
  Cam_FinishMove,
  Cam_Lock,
  Cam_Reset,
  Cam_Unlock,
  cl_chasecam,
  cl_hightrack,
  spec_track,
} from "../src/qw/client/cl_cam";
import { baseskin, noskins, Skin_Cache, Skin_Find } from "../src/qw/client/skin";
import { cl_predict_players, cl_predict_players2, cl_solid_players, clMainState } from "../src/qw/client/cl_main";
import { parseState } from "../src/qw/client/cl_parse";
import {
  PF_COMMAND,
  PF_DEAD,
  PF_EFFECTS,
  PF_MODEL,
  PF_MSEC,
  PF_SKINNUM,
  PF_VELOCITY1,
  PF_VELOCITY2,
  PF_VELOCITY3,
  PF_WEAPONFRAME,
  QwEntityStateT,
  QwUsercmdT,
  U_ANGLE1,
  U_ANGLE2,
  U_ANGLE3,
  U_COLORMAP,
  U_EFFECTS,
  U_FRAME,
  U_MODEL,
  U_MOREBITS,
  U_ORIGIN1,
  U_ORIGIN2,
  U_ORIGIN3,
  U_REMOVE,
  U_SKIN,
  UPDATE_BACKUP,
  UPDATE_MASK,
} from "../src/qw/protocol";
import { MSG_BeginReading, msgState, net_message, SZ_Alloc } from "../src/common/sizebuf";
import { movevars, player_maxs, player_mins, pmove, pmState } from "../src/qw/pmove_types";
import { COM_CheckRegistered, COM_InitArgv, COM_InitFilesystem, pop } from "../src/qw/common";
import { setComModified, setComSearchpaths } from "../src/common/common";
import { ensureDir, writePakToDisk } from "./support/pak_builder";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "qwcl-ents-test-"));

//============================================================================
// shared-singleton reset (standing order 15)

const savedCvars = [cl_nopred, cl_pushlatency, cl_predict_players, cl_predict_players2, cl_solid_players, cl_hightrack, cl_chasecam, baseskin, noskins].map(
  (c) => ({ c, value: c.value, string: c.string }),
);

// resetAll() (below) parks cls.state at ca_active as this file's own
// beforeEach/afterAll baseline, not the pristine ca_dedicated default --
// snapshotted here, before resetAll ever runs, and put back after afterAll's
// own resetAll() call so this file's real exit state matches what was there
// before it ran (rule 15).
const savedClsState = cls.state;

// Read cls.state without control-flow narrowing: a test that assigns
// cls.state a literal and then asserts a different member would otherwise
// compare two disjoint literal types.
function currentState(): CactiveT {
  return cls.state;
}

function feed(bytes: number[]): void {
  net_message.data = new Uint8Array(bytes);
  net_message.maxsize = bytes.length;
  net_message.cursize = bytes.length;
  MSG_BeginReading();
}

function resetAll(): void {
  setComSearchpaths(null);
  setComModified(false);

  cls.state = CactiveT.ca_active;
  cls.qw.latency = 0;
  cls.qw.downloadtype = DownloadTypeT.dl_none;
  cls.qw.downloadnumber = 0;
  cls.qw.netchan.incoming_sequence = 0;
  cls.qw.netchan.outgoing_sequence = 0;
  SZ_Alloc(cls.qw.netchan.message, 1024);

  cl.time = 0;
  cl.paused = false;
  cl.intermission = 0;
  cl.stats.fill(0);
  cl.viewangles[0] = cl.viewangles[1] = cl.viewangles[2] = 0;
  cl.model_precache.fill(null);
  cl.worldmodel = null;

  cl.qw.parsecount = 0;
  cl.qw.validsequence = 0;
  cl.qw.playernum = 0;
  cl.qw.spectator = 0;
  cl.qw.servercount = 0;
  cl.qw.simorg[0] = cl.qw.simorg[1] = cl.qw.simorg[2] = 0;
  cl.qw.simvel[0] = cl.qw.simvel[1] = cl.qw.simvel[2] = 0;
  cl.qw.simangles[0] = cl.qw.simangles[1] = cl.qw.simangles[2] = 0;
  for (const f of cl.qw.frames) {
    f.senttime = 0;
    f.receivedtime = 0;
    f.delta_sequence = 0;
    f.invalid = false;
    f.packet_entities.num_entities = 0;
    for (const e of f.packet_entities.entities) e.clear();
    for (const ps of f.playerstate) {
      ps.messagenum = 0;
      ps.state_time = 0;
      ps.origin[0] = ps.origin[1] = ps.origin[2] = 0;
      ps.velocity[0] = ps.velocity[1] = ps.velocity[2] = 0;
      ps.viewangles[0] = ps.viewangles[1] = ps.viewangles[2] = 0;
      ps.modelindex = 0;
      ps.frame = 0;
      ps.skinnum = 0;
      ps.effects = 0;
      ps.flags = 0;
      ps.weaponframe = 0;
      ps.onground = 0;
      ps.oldbuttons = 0;
      ps.waterjumptime = 0;
      ps.command.msec = 0;
      ps.command.forwardmove = ps.command.sidemove = ps.command.upmove = 0;
      ps.command.buttons = ps.command.impulse = 0;
      ps.command.angles[0] = ps.command.angles[1] = ps.command.angles[2] = 0;
    }
    f.cmd.msec = 0;
    f.cmd.forwardmove = f.cmd.sidemove = f.cmd.upmove = 0;
    f.cmd.buttons = f.cmd.impulse = 0;
    f.cmd.angles[0] = f.cmd.angles[1] = f.cmd.angles[2] = 0;
  }
  for (const p of cl.qw.players) {
    p.name = "";
    p.userinfo = "";
    p.frags = 0;
    p.spectator = 0;
    p.skin = null;
  }
  for (const b of cl_baselines) b.clear();

  for (const d of cl_dlights) {
    d.origin[0] = d.origin[1] = d.origin[2] = 0;
    d.radius = 0;
    d.die = 0;
    d.decay = 0;
    d.minlight = 0;
    d.key = 0;
  }

  clState.cl_numvisedicts = 0;
  cl_visedicts.fill(null);
  visState.list = 0;
  visState.oldlist = 1;
  visState.cl_oldnumvisedicts = 0;

  parseState.oldparsecountmod = 0;
  parseState.parsecountmod = 0;
  parseState.parsecounttime = 0;
  parseState.cl_spikeindex = 0;
  parseState.cl_playerindex = 0;
  parseState.cl_flagindex = -1;

  pmove.numphysent = 0;
  pmove.numtouch = 0;
  pmove.origin[0] = pmove.origin[1] = pmove.origin[2] = 0;
  pmove.velocity[0] = pmove.velocity[1] = pmove.velocity[2] = 0;
  pmove.angles[0] = pmove.angles[1] = pmove.angles[2] = 0;
  pmove.spectator = 0;
  pmove.dead = false;
  pmove.oldbuttons = 0;
  pmove.waterjumptime = 0;
  pmState.onground = 0;
  pmState.waterlevel = 0;
  pmState.watertype = 0;
  pmState.frametime = 0;

  movevars.gravity = 800;
  movevars.stopspeed = 100;
  movevars.maxspeed = 320;
  movevars.spectatormaxspeed = 500;
  movevars.accelerate = 10;
  movevars.airaccelerate = 0.7;
  movevars.wateraccelerate = 10;
  movevars.friction = 4;
  movevars.waterfriction = 4;
  movevars.entgravity = 1;

  clMainState.realtime = 0;
  clMainState.host_frametime = 0;

  cl_nopred.value = 0;
  cl_pushlatency.value = 0;
  cl_predict_players.value = 1;
  cl_predict_players2.value = 1;
  cl_solid_players.value = 1;
  cl_hightrack.value = 0;
  cl_chasecam.value = 0;
  baseskin.string = "base";
  noskins.value = 0;

  Cam_Reset();
  // cl_cam.c's file-static `oldbuttons` attack latch has no external reset:
  // releasing the button through Cam_FinishMove clears it, exactly as the
  // game does between frames. Cam_Reset has already zeroed autocam, so this
  // returns right after clearing the latch.
  cl.qw.spectator = 1;
  Cam_FinishMove(new QwUsercmdT());
  cl.qw.spectator = 0;

  msgState.readcount = 0;
  msgState.badread = false;
}

beforeEach(resetAll);

afterAll(() => {
  resetAll();
  for (const s of savedCvars) {
    s.c.value = s.value;
    s.c.string = s.string;
  }
  setComSearchpaths(null);
  setComModified(false);
  cls.state = savedClsState;
});

//============================================================================

describe("CL_ParseDelta", () => {
  test("decodes every U_* field off a hand-built stream and keeps the rest of the from-state", () => {
    const from = new QwEntityStateT();
    from.modelindex = 1;
    from.frame = 2;
    from.colormap = 3;
    from.skinnum = 4;
    from.effects = 5;
    from.origin[0] = 10;
    from.origin[1] = 20;
    from.origin[2] = 30;
    from.angles[0] = 40;
    from.angles[1] = 50;
    from.angles[2] = 60;

    const word = 5 | U_ORIGIN1 | U_ORIGIN2 | U_ORIGIN3 | U_ANGLE2 | U_FRAME | U_MOREBITS;
    const low = U_ANGLE1 | U_ANGLE3 | U_MODEL | U_COLORMAP | U_SKIN | U_EFFECTS;

    // read order: morebits, model, frame, colormap, skin, effects,
    // origin1, angle1, origin2, angle2, origin3, angle3
    feed([
      low,
      42, // modelindex
      7, // frame
      3, // colormap
      9, // skinnum
      0x11, // effects
      0x20,
      0x03, // origin[0] = 800/8 = 100
      32, // angles[0] = 32 * 360/256 = 45
      0x7e,
      0xff, // origin[1] = -130/8 = -16.25
      0x80, // angles[1] = -128 * 360/256 = -180
      68,
      0x00, // origin[2] = 68/8 = 8.5
      16, // angles[2] = 16 * 360/256 = 22.5
    ]);

    const to = new QwEntityStateT();
    CL_ParseDelta(from, to, word);

    expect(msgState.badread).toBe(false);
    expect(to.number).toBe(5);
    expect(to.flags).toBe((word & ~511) | low);
    expect(to.modelindex).toBe(42);
    expect(to.frame).toBe(7);
    expect(to.colormap).toBe(3);
    expect(to.skinnum).toBe(9);
    expect(to.effects).toBe(0x11);
    expect(to.origin[0]).toBeCloseTo(100, 6);
    expect(to.origin[1]).toBeCloseTo(-16.25, 6);
    expect(to.origin[2]).toBeCloseTo(8.5, 6);
    expect(to.angles[0]).toBeCloseTo(45, 4);
    expect(to.angles[1]).toBeCloseTo(-180, 4);
    expect(to.angles[2]).toBeCloseTo(22.5, 4);
  });

  test("with no bits set, every field is inherited from the delta source and nothing is read", () => {
    const from = new QwEntityStateT();
    from.modelindex = 11;
    from.frame = 12;
    from.colormap = 13;
    from.skinnum = 14;
    from.effects = 15;
    from.origin[0] = 1;
    from.origin[1] = 2;
    from.origin[2] = 3;
    from.angles[0] = 4;
    from.angles[1] = 5;
    from.angles[2] = 6;

    feed([0xde, 0xad]);
    const to = new QwEntityStateT();
    CL_ParseDelta(from, to, 17);

    expect(msgState.readcount).toBe(0); // nothing consumed
    expect(to.number).toBe(17);
    expect(to.flags).toBe(0);
    expect(to.modelindex).toBe(11);
    expect(to.frame).toBe(12);
    expect(to.colormap).toBe(13);
    expect(to.skinnum).toBe(14);
    expect(to.effects).toBe(15);
    expect(Array.from(to.origin)).toEqual([1, 2, 3]);
    expect(Array.from(to.angles)).toEqual([4, 5, 6]);
  });

  test("U_REMOVE survives into to.flags and the entity number is the low nine bits", () => {
    const from = new QwEntityStateT();
    const to = new QwEntityStateT();
    feed([]);
    CL_ParseDelta(from, to, 511 | U_REMOVE);
    expect(to.number).toBe(511);
    expect(to.flags).toBe(U_REMOVE);
  });
});

//============================================================================

function short(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff];
}

describe("CL_ParsePacketEntities", () => {
  test("full update builds the packet from cl_baselines, in stream order, and validates the sequence", () => {
    cls.qw.netchan.incoming_sequence = 4;
    cls.qw.netchan.outgoing_sequence = 5;

    cl_baselines[3].modelindex = 11;
    cl_baselines[7].modelindex = 22;

    feed([
      ...short(3 | U_FRAME),
      5, // frame
      ...short(7),
      ...short(0),
    ]);

    CL_ParsePacketEntities(false);

    const newp = cl.qw.frames[4 & UPDATE_MASK].packet_entities;
    expect(newp.num_entities).toBe(2);
    expect(newp.entities[0].number).toBe(3);
    expect(newp.entities[0].modelindex).toBe(11);
    expect(newp.entities[0].frame).toBe(5);
    expect(newp.entities[1].number).toBe(7);
    expect(newp.entities[1].modelindex).toBe(22);
    expect(cl.qw.validsequence).toBe(4);
    expect(cl.qw.frames[4 & UPDATE_MASK].invalid).toBe(false);
  });

  test("delta update keeps unmentioned entities, removes U_REMOVE ones and inserts new ones in number order", () => {
    const oldpacket = 4;
    const newpacket = 5;
    cls.qw.netchan.incoming_sequence = newpacket;
    cls.qw.netchan.outgoing_sequence = newpacket + 1;
    cl.qw.frames[newpacket & UPDATE_MASK].delta_sequence = oldpacket;

    const oldp = cl.qw.frames[oldpacket & UPDATE_MASK].packet_entities;
    oldp.num_entities = 3;
    oldp.entities[0].number = 3;
    oldp.entities[0].modelindex = 30;
    oldp.entities[1].number = 5;
    oldp.entities[1].modelindex = 50;
    oldp.entities[2].number = 9;
    oldp.entities[2].modelindex = 90;

    cl_baselines[7].modelindex = 70;

    feed([
      oldpacket & UPDATE_MASK, // the `from` byte
      ...short(5 | U_REMOVE),
      ...short(7 | U_FRAME),
      2, // frame for the new entity 7
      ...short(0),
    ]);

    CL_ParsePacketEntities(true);

    const newp = cl.qw.frames[newpacket & UPDATE_MASK].packet_entities;
    expect(newp.num_entities).toBe(3);
    expect(newp.entities.slice(0, 3).map((e) => e.number)).toEqual([3, 7, 9]);
    expect(newp.entities[0].modelindex).toBe(30); // kept unchanged
    expect(newp.entities[1].modelindex).toBe(70); // new, from the baseline
    expect(newp.entities[1].frame).toBe(2);
    expect(newp.entities[2].modelindex).toBe(90); // copied after the terminator
    expect(cl.qw.validsequence).toBe(newpacket);
  });

  test("a from-frame older than UPDATE_BACKUP-1 flushes the packet: validsequence 0 and the frame marked invalid", () => {
    const oldpacket = 1;
    const newpacket = 3;
    cls.qw.netchan.incoming_sequence = newpacket;
    cls.qw.netchan.outgoing_sequence = oldpacket + UPDATE_BACKUP - 1;
    cl.qw.frames[newpacket & UPDATE_MASK].delta_sequence = oldpacket;
    cl.qw.validsequence = 99;

    feed([oldpacket & UPDATE_MASK, ...short(0)]);

    CL_ParsePacketEntities(true);

    expect(cl.qw.validsequence).toBe(0);
    expect(cl.qw.frames[newpacket & UPDATE_MASK].invalid).toBe(true);
    expect(msgState.badread).toBe(false);
  });
});

//============================================================================

describe("CL_ParsePlayerinfo", () => {
  test("reads every PF_* field into frames[parsecountmod].playerstate[num]", () => {
    cl.qw.parsecount = 12;
    parseState.parsecountmod = 12 & UPDATE_MASK;
    parseState.parsecounttime = 5.0;

    const flags =
      PF_MSEC | PF_COMMAND | PF_VELOCITY1 | PF_VELOCITY2 | PF_VELOCITY3 | PF_MODEL | PF_SKINNUM | PF_EFFECTS | PF_WEAPONFRAME;

    feed([
      2, // player number
      ...short(flags),
      ...short(8), // origin[0] = 1
      ...short(16), // origin[1] = 2
      ...short(24), // origin[2] = 3
      33, // frame
      50, // msec
      // MSG_ReadDeltaUsercmd: bits byte, then msec byte
      0,
      17,
      ...short(100), // velocity[0]
      ...short(-200), // velocity[1]
      ...short(300), // velocity[2]
      41, // modelindex
      6, // skinnum
      0x22, // effects
      13, // weaponframe
    ]);

    CL_ParsePlayerinfo();

    const st = cl.qw.frames[12 & UPDATE_MASK].playerstate[2];
    expect(msgState.badread).toBe(false);
    expect(st.flags).toBe(flags);
    expect(st.messagenum).toBe(12);
    expect(Array.from(st.origin)).toEqual([1, 2, 3]);
    expect(st.frame).toBe(33);
    expect(st.state_time).toBeCloseTo(5.0 - 0.05, 9);
    expect(st.command.msec).toBe(17);
    expect(Array.from(st.velocity)).toEqual([100, -200, 300]);
    expect(st.modelindex).toBe(41);
    expect(st.skinnum).toBe(6);
    expect(st.effects).toBe(0x22);
    expect(st.weaponframe).toBe(13);
  });

  test("with no PF_* bits set, the defaults are cl_playerindex / zeroes and state_time is parsecounttime", () => {
    cl.qw.parsecount = 3;
    parseState.parsecountmod = 3;
    parseState.parsecounttime = 2.5;
    parseState.cl_playerindex = 7;

    feed([1, ...short(0), ...short(0), ...short(0), ...short(0), 0]);

    CL_ParsePlayerinfo();

    const st = cl.qw.frames[3].playerstate[1];
    expect(st.state_time).toBe(2.5);
    expect(st.modelindex).toBe(7);
    expect(st.skinnum).toBe(0);
    expect(st.effects).toBe(0);
    expect(st.weaponframe).toBe(0);
    expect(Array.from(st.velocity)).toEqual([0, 0, 0]);
  });
});

//============================================================================

describe("CL_SetUpPlayerPrediction / CL_SetSolidPlayers", () => {
  function makePlayersPresent(): void {
    cl.qw.parsecount = 0;
    cl.qw.playernum = 0;
    const frame = cl.qw.frames[0];
    for (const j of [0, 1, 2, 3]) {
      const ps = frame.playerstate[j];
      ps.messagenum = 0;
      ps.modelindex = 1;
      ps.origin[0] = 100 * j;
      ps.origin[1] = 0;
      ps.origin[2] = 0;
      ps.state_time = 0;
    }
    frame.playerstate[3].flags = PF_DEAD;
  }

  test("fills pmove.physents with every active, live, non-self player, using player_mins/player_maxs", () => {
    makePlayersPresent();
    cl_predict_players.value = 0;
    cl_predict_players2.value = 0;

    CL_SetUpPlayerPrediction(false);

    pmove.numphysent = 1; // the world, as CL_SetSolidEntities leaves it
    CL_SetSolidPlayers(0);

    // players 1 and 2 are solid; 0 is the caller and 3 is dead
    expect(pmove.numphysent).toBe(3);
    expect(pmove.physents[1].model).toBe(null);
    expect(Array.from(pmove.physents[1].origin)).toEqual([100, 0, 0]);
    expect(Array.from(pmove.physents[2].origin)).toEqual([200, 0, 0]);
    expect(Array.from(pmove.physents[1].mins)).toEqual(Array.from(player_mins));
    expect(Array.from(pmove.physents[1].maxs)).toEqual(Array.from(player_maxs));
  });

  test("cl_solid_players 0 adds nothing", () => {
    makePlayersPresent();
    cl_predict_players.value = 0;
    cl_predict_players2.value = 0;
    CL_SetUpPlayerPrediction(false);

    cl_solid_players.value = 0;
    pmove.numphysent = 1;
    CL_SetSolidPlayers(0);
    expect(pmove.numphysent).toBe(1);
  });

  test("a player absent from this frame is not made solid", () => {
    makePlayersPresent();
    cl.qw.frames[0].playerstate[1].messagenum = -1; // not present this frame
    cl_predict_players.value = 0;
    cl_predict_players2.value = 0;
    CL_SetUpPlayerPrediction(false);

    pmove.numphysent = 1;
    CL_SetSolidPlayers(0);
    expect(pmove.numphysent).toBe(2);
    expect(Array.from(pmove.physents[1].origin)).toEqual([200, 0, 0]);
  });
});

describe("CL_SetSolidEntities", () => {
  test("physent 0 is the world at the origin and nothing else is added without models", () => {
    parseState.parsecountmod = 0;
    const pak = cl.qw.frames[0].packet_entities;
    pak.num_entities = 1;
    pak.entities[0].number = 3;
    pak.entities[0].modelindex = 2; // cl.model_precache[2] is null in this suite

    CL_SetSolidEntities();

    expect(pmove.numphysent).toBe(1);
    expect(pmove.physents[0].model).toBe(null); // cl.worldmodel
    expect(Array.from(pmove.physents[0].origin)).toEqual([0, 0, 0]);
    expect(pmove.physents[0].info).toBe(0);
  });
});

//============================================================================

describe("dlights", () => {
  test("CL_AllocDlight reuses the slot with a matching key, then the first dead one", () => {
    cl.time = 10;
    const a = CL_AllocDlight(7);
    a.radius = 55;
    a.die = 20;
    const b = CL_AllocDlight(7);
    expect(b).toBe(a);
    expect(b.radius).toBe(0); // the memset
    expect(b.key).toBe(7);

    b.die = 20;
    const c = CL_AllocDlight(8);
    expect(c).not.toBe(a);
    expect(c.key).toBe(8);
  });

  test("CL_NewDlight sets origin/radius/die from cl.time", () => {
    cl.time = 3;
    CL_NewDlight(1, 5, 6, 7, 250, 0.1, 0);
    const dl = cl_dlights.find((d) => d.key === 1);
    expect(dl).toBeDefined();
    if (!dl) throw new Error("no dlight");
    expect(Array.from(dl.origin)).toEqual([5, 6, 7]);
    expect(dl.radius).toBe(250);
    expect(dl.die).toBeCloseTo(3.1, 6);
  });

  test("CL_DecayLights shrinks live lights by host_frametime*decay and clamps at zero", () => {
    cl.time = 0;
    clMainState.host_frametime = 0.5;
    cl_dlights[0].die = 10;
    cl_dlights[0].radius = 100;
    cl_dlights[0].decay = 100;
    cl_dlights[1].die = 10;
    cl_dlights[1].radius = 10;
    cl_dlights[1].decay = 100;
    cl_dlights[2].die = -1; // already dead
    cl_dlights[2].radius = 100;
    cl_dlights[2].decay = 100;

    CL_DecayLights();

    expect(cl_dlights[0].radius).toBeCloseTo(50, 6);
    expect(cl_dlights[1].radius).toBe(0);
    expect(cl_dlights[2].radius).toBe(100);
    expect(MAX_DLIGHTS).toBe(32);
  });
});

//============================================================================

describe("projectiles (svc_nails)", () => {
  test("CL_ParseProjectiles unpacks the six-byte nail encoding and CL_LinkProjectiles emits visedicts", () => {
    CL_ClearProjectiles();
    parseState.cl_spikeindex = 2;
    cl.model_precache[2] = null;

    // origin[0] = ((0x34 + (0x2<<8))<<1) - 4096
    const b = [0x34, 0x12, 0x00, 0x10, 0x30, 0x80];
    feed([1, ...b]);
    CL_ParseProjectiles();

    expect(projState.cl_num_projectiles).toBe(1);
    const pr = cl_projectiles[0];
    expect(pr.modelindex).toBe(2);
    expect(pr.origin[0]).toBe(((0x34 + ((0x12 & 15) << 8)) << 1) - 4096);
    expect(pr.origin[1]).toBe((((0x12 >> 4) + (0x00 << 4)) << 1) - 4096);
    expect(pr.origin[2]).toBe(((0x10 + ((0x30 & 15) << 8)) << 1) - 4096);
    expect(pr.angles[0]).toBe(Math.trunc((360 * (0x30 >> 4)) / 16));
    expect(pr.angles[1]).toBe(Math.trunc((360 * 0x80) / 256));

    clState.cl_numvisedicts = 0;
    CL_LinkProjectiles();
    expect(clState.cl_numvisedicts).toBe(1);
  });
});

//============================================================================

describe("CL_PredictMove", () => {
  function setUpFrames(): void {
    cls.state = CactiveT.ca_active;
    cls.qw.netchan.incoming_sequence = 10;
    cls.qw.netchan.outgoing_sequence = 12;
    cl.qw.validsequence = 1;
    cl.qw.playernum = 1;
    cl.qw.spectator = 1; // PlayerMove takes SpectatorMove: no world hulls needed
    cl_solid_players.value = 0;
    clMainState.realtime = 100;

    const from = cl.qw.frames[10 & UPDATE_MASK];
    from.senttime = 99.9;
    const fs = from.playerstate[1];
    fs.origin[0] = 64;
    fs.origin[1] = 0;
    fs.origin[2] = 0;
    fs.velocity[0] = 200;

    const to = cl.qw.frames[11 & UPDATE_MASK];
    to.senttime = 100;
    to.cmd.msec = 50;
    to.cmd.forwardmove = 400;
    to.cmd.angles[0] = 0;
    to.cmd.angles[1] = 0;
    to.cmd.angles[2] = 0;
  }

  test("cl_nopred copies the last received frame straight into cl.simorg/cl.simvel", () => {
    setUpFrames();
    cl_nopred.value = 1;

    CL_PredictMove();

    expect(Array.from(cl.qw.simorg)).toEqual([64, 0, 0]);
    expect(Array.from(cl.qw.simvel)).toEqual([200, 0, 0]);
    expect(cl.time).toBeCloseTo(100, 9);
  });

  test("with prediction on, cl.simorg advances past the last received origin", () => {
    setUpFrames();
    cl_nopred.value = 0;

    CL_PredictMove();

    // f == 1 (cl.time == to->senttime), so simorg is the predicted frame's origin
    const predicted = cl.qw.frames[11 & UPDATE_MASK].playerstate[1].origin;
    expect(cl.qw.simorg[0]).toBeCloseTo(predicted[0], 6);
    expect(cl.qw.simorg[0]).toBeGreaterThan(64);
    expect(cl.qw.simvel[0]).toBeGreaterThan(0);
  });

  test("returns early while paused, on intermission, and with no valid sequence", () => {
    setUpFrames();
    cl.paused = true;
    CL_PredictMove();
    expect(Array.from(cl.qw.simorg)).toEqual([0, 0, 0]);

    resetAll();
    setUpFrames();
    cl.intermission = 1;
    CL_PredictMove();
    expect(Array.from(cl.qw.simorg)).toEqual([0, 0, 0]);

    resetAll();
    setUpFrames();
    cl.qw.validsequence = 0;
    CL_PredictMove();
    expect(Array.from(cl.qw.simorg)).toEqual([0, 0, 0]);
  });

  test("ca_onserver becomes ca_active on the first predicted frame", () => {
    setUpFrames();
    cls.state = CactiveT.ca_onserver;
    cl_nopred.value = 1;
    CL_PredictMove();
    expect(currentState()).toBe(CactiveT.ca_active);
  });

  test("CL_PredictUsercmd splits a move longer than 50 msec and lands on the same state either way", () => {
    cl.qw.spectator = 1;
    const from = cl.qw.frames[0].playerstate[0];
    from.origin[0] = 0;
    from.velocity[0] = 100;

    const cmd = cl.qw.frames[0].cmd;
    cmd.msec = 100;
    cmd.forwardmove = 400;

    const to = cl.qw.frames[1].playerstate[0];
    CL_PredictUsercmd(from, to, cmd, true);

    expect(to.origin[0]).toBeGreaterThan(0);
    expect(from.origin[0]).toBe(0); // the source state is untouched
  });
});

//============================================================================

describe("Cam_* spectator camera", () => {
  test("Cam_Reset clears autocam and spec_track", () => {
    cl.qw.spectator = 1;
    Cam_Lock(4);
    expect(spec_track).toBe(4);
    Cam_Reset();
    expect(autocam).toBe(0);
    expect(spec_track).toBe(0);
  });

  test("Cam_Lock writes a clc_stringcmd 'ptrack <n>' onto the netchan message", () => {
    const before = cls.qw.netchan.message.cursize;
    Cam_Lock(9);
    const buf = cls.qw.netchan.message;
    expect(buf.cursize).toBeGreaterThan(before);
    let s = "";
    for (let i = before + 1; i < buf.cursize - 1; i++) s += String.fromCharCode(buf.data[i]);
    expect(s).toBe("ptrack 9");
    expect(spec_track).toBe(9);
  });

  test("Cam_Unlock is a no-op while not tracking and resets autocam once tracking", () => {
    const before = cls.qw.netchan.message.cursize;
    Cam_Unlock();
    expect(cls.qw.netchan.message.cursize).toBe(before);

    cl.qw.spectator = 1;
    cls.state = CactiveT.ca_active;
    cl.qw.players[0].name = "alpha";
    const cmd = cl.qw.frames[0].cmd;
    cmd.buttons = 1; // BUTTON_ATTACK
    Cam_FinishMove(cmd);
    expect(autocam).toBe(1); // CAM_TRACK
    expect(spec_track).toBe(0);

    Cam_Unlock();
    expect(autocam).toBe(0);
  });

  test("Cam_FinishMove walks to the next non-spectator player with a name", () => {
    cl.qw.spectator = 1;
    cls.state = CactiveT.ca_active;
    cl.qw.players[2].name = "bob";
    cl.qw.players[5].name = "ghost";
    cl.qw.players[5].spectator = 1;

    const cmd = cl.qw.frames[0].cmd;
    cmd.buttons = 1;
    Cam_FinishMove(cmd);

    expect(spec_track).toBe(2);
    expect(autocam).toBe(1);
  });

  test("Cam_FinishMove does nothing outside spectator mode or outside ca_active", () => {
    cl.qw.spectator = 0;
    const cmd = cl.qw.frames[0].cmd;
    cmd.buttons = 1;
    Cam_FinishMove(cmd);
    expect(autocam).toBe(0);

    cl.qw.spectator = 1;
    cls.state = CactiveT.ca_connected;
    Cam_FinishMove(cmd);
    expect(autocam).toBe(0);
  });

  test("Cam_DrawViewModel / Cam_DrawPlayer follow cl_chasecam and the tracked player", () => {
    cl.qw.spectator = 0;
    expect(Cam_DrawViewModel()).toBe(true);
    expect(Cam_DrawPlayer(0)).toBe(true);

    cl.qw.spectator = 1;
    expect(Cam_DrawViewModel()).toBe(false); // not locked
    expect(Cam_DrawPlayer(0)).toBe(true);
  });
});

//============================================================================

function popLmpBytes(): Uint8Array {
  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }
  return popLmp;
}

// A PCX exactly as skin.c reads it: 128-byte header then the RLE stream.
// `rows` supplies the decoded rows the loop will read (it runs y < ymax).
function buildPcx(xmax: number, ymax: number, stream: number[], header?: Partial<Record<"manufacturer" | "version" | "encoding" | "bits_per_pixel", number>>): Uint8Array {
  const buf = new Uint8Array(128 + stream.length);
  const dv = new DataView(buf.buffer);
  buf[0] = header?.manufacturer ?? 0x0a;
  buf[1] = header?.version ?? 5;
  buf[2] = header?.encoding ?? 1;
  buf[3] = header?.bits_per_pixel ?? 8;
  dv.setUint16(4, 0, true); // xmin
  dv.setUint16(6, 0, true); // ymin
  dv.setUint16(8, xmax, true);
  dv.setUint16(10, ymax, true);
  dv.setUint16(66, xmax + 1, true); // bytes_per_line
  buf.set(stream, 128);
  return buf;
}

describe("Skin_Find", () => {
  test("a userinfo skin containing '..' or starting with '.' falls back to \"base\"", () => {
    const sc = new PlayerInfoT();
    sc.userinfo = "\\skin\\../../etc/passwd";
    Skin_Find(sc);
    expect(sc.skin).not.toBe(null);
    expect(sc.skin?.name).toBe("base");

    const sc2 = new PlayerInfoT();
    sc2.userinfo = "\\skin\\.hidden";
    Skin_Find(sc2);
    expect(sc2.skin?.name).toBe("base");
  });

  test("no skin key in userinfo uses the baseskin cvar, and the extension is stripped", () => {
    baseskin.string = "base";
    const sc = new PlayerInfoT();
    sc.userinfo = "\\name\\Player";
    Skin_Find(sc);
    expect(sc.skin?.name).toBe("base");

    const sc2 = new PlayerInfoT();
    sc2.userinfo = "\\skin\\qwcltrunc1.pcx";
    Skin_Find(sc2);
    expect(sc2.skin?.name).toBe("qwcltrunc1");
  });

  test("the skin name is truncated to skin_t.name's 15 usable characters", () => {
    const sc = new PlayerInfoT();
    sc.userinfo = "\\skin\\qwclaaaabbbbccccdddd";
    Skin_Find(sc);
    expect(sc.skin?.name).toBe("qwclaaaabbbbccc");
    expect(sc.skin?.name.length).toBe(15);
  });

  test("the same name resolves to the same cached skin_t", () => {
    const a = new PlayerInfoT();
    a.userinfo = "\\skin\\qwclshared";
    Skin_Find(a);
    const b = new PlayerInfoT();
    b.userinfo = "\\skin\\qwclshared";
    Skin_Find(b);
    expect(b.skin).toBe(a.skin);
  });
});

describe("Skin_Cache", () => {
  const baseDir = join(scratchDir, "skinfs");

  const goodStream = [1, 2, 3, 4, 5, 6, 7, 8]; // two rows of four literal pixels
  const runStream = [0xc0 | 10, 77, 0, 0, 0, 0, 0, 0];

  function mountFs(): void {
    ensureDir(join(baseDir, "id1"));
    ensureDir(join(baseDir, "qw"));
    writePakToDisk(join(baseDir, "qw", "pak0.pak"), [
      { name: "gfx/pop.lmp", data: popLmpBytes() },
      { name: "skins/qwclgood.pcx", data: buildPcx(3, 2, goodStream) },
      { name: "skins/qwclbadhdr.pcx", data: buildPcx(3, 2, goodStream, { version: 3 }) },
      { name: "skins/qwclbadrun.pcx", data: buildPcx(3, 2, runStream) },
      { name: "skins/base.pcx", data: buildPcx(3, 2, goodStream) },
    ]);
    COM_InitArgv(["quake", "-basedir", baseDir]);
    COM_InitFilesystem();
    COM_CheckRegistered();
  }

  test("decodes a synthetic PCX into the 320*200 cache buffer", () => {
    mountFs();
    const skin = new SkinT();
    skin.name = "qwclgood";

    const out = Skin_Cache(skin);
    expect(out).not.toBe(null);
    if (!out) throw new Error("no skin");
    expect(out.length).toBe(320 * 200);
    expect(Array.from(out.subarray(0, 4))).toEqual([1, 2, 3, 4]);
    expect(Array.from(out.subarray(320, 324))).toEqual([5, 6, 7, 8]);
    expect(out[4]).toBe(0); // beyond xmax, untouched
    expect(out[640]).toBe(0); // the third row is never decoded (y < ymax)
    expect(skin.failedload).toBe(false);

    // a second call comes back out of the cache, same buffer
    expect(Skin_Cache(skin)).toBe(out);
  });

  test("a bad PCX header sets failedload and returns null", () => {
    mountFs();
    const skin = new SkinT();
    skin.name = "qwclbadhdr";
    expect(Skin_Cache(skin)).toBe(null);
    expect(skin.failedload).toBe(true);
    // failedload short-circuits every later call
    expect(Skin_Cache(skin)).toBe(null);
  });

  test("a run longer than xmax+2 is rejected, the cache is freed and failedload is set", () => {
    mountFs();
    const skin = new SkinT();
    skin.name = "qwclbadrun";
    expect(Skin_Cache(skin)).toBe(null);
    expect(skin.failedload).toBe(true);
    expect(skin.cache.data).toBe(null);
  });

  test("a missing skin falls back to baseskin's pcx", () => {
    mountFs();
    baseskin.string = "base";
    const skin = new SkinT();
    skin.name = "qwclmissing";
    const out = Skin_Cache(skin);
    expect(out).not.toBe(null);
    if (!out) throw new Error("no skin");
    expect(Array.from(out.subarray(0, 4))).toEqual([1, 2, 3, 4]);
  });

  test("returns null while a skin download is in flight, and while noskins is exactly 1", () => {
    mountFs();
    const skin = new SkinT();
    skin.name = "qwclgood";

    cls.qw.downloadtype = DownloadTypeT.dl_skin;
    expect(Skin_Cache(skin)).toBe(null);
    cls.qw.downloadtype = DownloadTypeT.dl_none;

    noskins.value = 1;
    expect(Skin_Cache(skin)).toBe(null);
    noskins.value = 2; // "So NOSKINS > 1 will show skins"
    expect(Skin_Cache(skin)).not.toBe(null);
    noskins.value = 0;
  });
});

//============================================================================

describe("visedict plumbing", () => {
  test("CL_EmitEntities publishes one half of cl_visedicts_list and resets the counter", () => {
    cls.state = CactiveT.ca_active;
    cl.qw.validsequence = 1;
    cls.qw.netchan.incoming_sequence = 6;
    clState.cl_numvisedicts = 5;

    // no packet entities, no players, no nails, so the three linkers do nothing
    CL_EmitEntities();

    expect(visState.cl_oldnumvisedicts).toBe(5);
    expect(visState.list).toBe(0);
    expect(visState.oldlist).toBe(1);
    expect(cl_visedicts[0]).toBe(cl_visedicts_list[0][0]);
    expect(cl_visedicts.length).toBe(MAX_VISEDICTS);
    expect(cl_visedicts_list[0][0] instanceof EntityT).toBe(true);
  });
});
