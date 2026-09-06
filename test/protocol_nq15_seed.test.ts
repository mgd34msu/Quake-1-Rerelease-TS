// Protocol 15 regression: the nq15 codec must emit exactly the bytes the seed
// emitted before the codec seam existed.
//
// The functions named `seed*` below are the pre-seam encoders, transcribed
// literally out of the versions of src/server/sv_main.ts and
// src/progs/pr_cmds.ts that this unit replaced -- same order, same
// comparisons, same MSG_Write* calls (which are themselves untouched: nothing
// in this unit changed MSG_WriteCoord or MSG_WriteAngle, only added the
// suffixed flag-taking variants beside them). They take plain field bags
// instead of an EdictT so this file needs no progs.dat, no server and no
// singletons at all.
//
// Every case below is then encoded twice -- once through `seed*`, once through
// `nq15Codec` -- and the two byte strings are compared. A difference is a
// protocol-15 regression, whatever else the wide protocols gained.
//
// Self-sufficiency: this file touches no shared singleton. Every SizeBuf it
// writes to is freshly allocated per call, and nothing here reads net_message,
// a cvar, cl/cls/sv/svs or a builtin table.

import { describe, expect, test } from "bun:test";
import {
  MSG_WriteAngle,
  MSG_WriteByte,
  MSG_WriteChar,
  MSG_WriteCoord,
  MSG_WriteLong,
  MSG_WriteShort,
  SizeBuf,
} from "../src/common/sizebuf";
import { EntityStateT } from "../src/common/quakedef";
import { vec3, type Vec3 } from "../src/common/mathlib";
import {
  DEFAULT_SOUND_PACKET_ATTENUATION,
  DEFAULT_SOUND_PACKET_VOLUME,
  DEFAULT_VIEWHEIGHT,
  SND_ATTENUATION,
  SND_VOLUME,
  SU_ARMOR,
  SU_IDEALPITCH,
  SU_INWATER,
  SU_ITEMS,
  SU_ONGROUND,
  SU_PUNCH1,
  SU_VELOCITY1,
  SU_VIEWHEIGHT,
  SU_WEAPON,
  SU_WEAPONFRAME,
  SvcOpsT,
  U_ANGLE1,
  U_ANGLE2,
  U_ANGLE3,
  U_COLORMAP,
  U_EFFECTS,
  U_FRAME,
  U_LONGENTITY,
  U_MODEL,
  U_MOREBITS,
  U_NOLERP,
  U_ORIGIN1,
  U_ORIGIN2,
  U_ORIGIN3,
  U_SIGNAL,
  U_SKIN,
} from "../src/common/protocol";
import { ClientdataT, EntityUpdateT, SoundMessageT } from "../src/common/protocol/codec";
import { nq15Codec } from "../src/common/protocol/nq15";

function buf(): SizeBuf {
  const sb = new SizeBuf();
  sb.data = new Uint8Array(1024);
  sb.maxsize = sb.data.length;
  sb.cursize = 0;
  return sb;
}

function bytes(sb: SizeBuf): number[] {
  return Array.from(sb.data.subarray(0, sb.cursize));
}

//============================================================================
// The seed's encoders, transcribed.

// src/server/sv_main.ts's SV_WriteEntitiesToClient, from `let bits = 0` to the
// last MSG_WriteAngle. `ent.v.*` becomes `v.*` and `ent.baseline` becomes
// `baseline`; nothing else changes.
interface SeedEntVars {
  origin: Vec3;
  angles: Vec3;
  movetype: number;
  colormap: number;
  skin: number;
  frame: number;
  effects: number;
  modelindex: number;
}

const SEED_MOVETYPE_STEP = 4; // server.ts's MOVETYPE_STEP

function seedWriteEntityUpdate(msg: SizeBuf, e: number, v: SeedEntVars, baseline: EntityStateT): void {
  // send an update
  let bits = 0;

  for (let i = 0; i < 3; i++) {
    const miss = v.origin[i] - baseline.origin[i];
    if (miss < -0.1 || miss > 0.1) bits |= U_ORIGIN1 << i;
  }

  if (v.angles[0] !== baseline.angles[0]) bits |= U_ANGLE1;

  if (v.angles[1] !== baseline.angles[1]) bits |= U_ANGLE2;

  if (v.angles[2] !== baseline.angles[2]) bits |= U_ANGLE3;

  if (v.movetype === SEED_MOVETYPE_STEP) bits |= U_NOLERP; // don't mess up the step animation

  if (baseline.colormap !== v.colormap) bits |= U_COLORMAP;

  if (baseline.skin !== v.skin) bits |= U_SKIN;

  if (baseline.frame !== v.frame) bits |= U_FRAME;

  if (baseline.effects !== v.effects) bits |= U_EFFECTS;

  if (baseline.modelindex !== v.modelindex) bits |= U_MODEL;

  if (e >= 256) bits |= U_LONGENTITY;

  if (bits >= 256) bits |= U_MOREBITS;

  // write the message
  MSG_WriteByte(msg, bits | U_SIGNAL);

  if (bits & U_MOREBITS) MSG_WriteByte(msg, bits >> 8);
  if (bits & U_LONGENTITY) MSG_WriteShort(msg, e);
  else MSG_WriteByte(msg, e);

  if (bits & U_MODEL) MSG_WriteByte(msg, v.modelindex);
  if (bits & U_FRAME) MSG_WriteByte(msg, v.frame);
  if (bits & U_COLORMAP) MSG_WriteByte(msg, v.colormap);
  if (bits & U_SKIN) MSG_WriteByte(msg, v.skin);
  if (bits & U_EFFECTS) MSG_WriteByte(msg, v.effects);
  if (bits & U_ORIGIN1) MSG_WriteCoord(msg, v.origin[0]);
  if (bits & U_ANGLE1) MSG_WriteAngle(msg, v.angles[0]);
  if (bits & U_ORIGIN2) MSG_WriteCoord(msg, v.origin[1]);
  if (bits & U_ANGLE2) MSG_WriteAngle(msg, v.angles[1]);
  if (bits & U_ORIGIN3) MSG_WriteCoord(msg, v.origin[2]);
  if (bits & U_ANGLE3) MSG_WriteAngle(msg, v.angles[2]);
}

// src/server/sv_main.ts's SV_CreateBaseline, "add to the message" block only
// (the baseline fields themselves are filled by the caller in both versions).
function seedWriteBaseline(signon: SizeBuf, entnum: number, baseline: EntityStateT): void {
  MSG_WriteByte(signon, SvcOpsT.svc_spawnbaseline);
  MSG_WriteShort(signon, entnum);

  MSG_WriteByte(signon, baseline.modelindex);
  MSG_WriteByte(signon, baseline.frame);
  MSG_WriteByte(signon, baseline.colormap);
  MSG_WriteByte(signon, baseline.skin);
  for (let i = 0; i < 3; i++) {
    MSG_WriteCoord(signon, baseline.origin[i]);
    MSG_WriteAngle(signon, baseline.angles[i]);
  }
}

// src/server/sv_main.ts's SV_WriteClientdataToMessage, from `let bits = 0` on.
// The damage / SV_SetIdealPitch / fixangle prologue is not part of the codec
// on either side of this change, so it is not transcribed.
interface SeedClientVars {
  view_ofs2: number;
  idealpitch: number;
  items: number;
  flagsOnGround: boolean;
  waterlevel: number;
  punchangle: Vec3;
  velocity: Vec3;
  weaponframe: number;
  armorvalue: number;
  weaponmodelIndex: number;
  health: number;
  currentammo: number;
  ammo_shells: number;
  ammo_nails: number;
  ammo_rockets: number;
  ammo_cells: number;
  weapon: number;
  standardQuake: boolean;
}

function seedWriteClientdata(msg: SizeBuf, v: SeedClientVars): void {
  let bits = 0;

  if (v.view_ofs2 !== DEFAULT_VIEWHEIGHT) bits |= SU_VIEWHEIGHT;

  if (v.idealpitch) bits |= SU_IDEALPITCH;

  const items = v.items;

  bits |= SU_ITEMS;

  if (v.flagsOnGround) bits |= SU_ONGROUND;

  if (v.waterlevel >= 2) bits |= SU_INWATER;

  for (let i = 0; i < 3; i++) {
    if (v.punchangle[i]) bits |= SU_PUNCH1 << i;
    if (v.velocity[i]) bits |= SU_VELOCITY1 << i;
  }

  if (v.weaponframe) bits |= SU_WEAPONFRAME;

  if (v.armorvalue) bits |= SU_ARMOR;

  //	if (ent->v.weapon)
  bits |= SU_WEAPON;

  // send the data

  MSG_WriteByte(msg, SvcOpsT.svc_clientdata);
  MSG_WriteShort(msg, bits);

  if (bits & SU_VIEWHEIGHT) MSG_WriteChar(msg, v.view_ofs2);

  if (bits & SU_IDEALPITCH) MSG_WriteChar(msg, v.idealpitch);

  for (let i = 0; i < 3; i++) {
    if (bits & (SU_PUNCH1 << i)) MSG_WriteChar(msg, v.punchangle[i]);
    if (bits & (SU_VELOCITY1 << i)) MSG_WriteChar(msg, v.velocity[i] / 16);
  }

  // [always sent]	if (bits & SU_ITEMS)
  MSG_WriteLong(msg, items);

  if (bits & SU_WEAPONFRAME) MSG_WriteByte(msg, v.weaponframe);
  if (bits & SU_ARMOR) MSG_WriteByte(msg, v.armorvalue);
  if (bits & SU_WEAPON) MSG_WriteByte(msg, v.weaponmodelIndex);

  MSG_WriteShort(msg, v.health);
  MSG_WriteByte(msg, v.currentammo);
  MSG_WriteByte(msg, v.ammo_shells);
  MSG_WriteByte(msg, v.ammo_nails);
  MSG_WriteByte(msg, v.ammo_rockets);
  MSG_WriteByte(msg, v.ammo_cells);

  if (v.standardQuake) {
    MSG_WriteByte(msg, v.weapon);
  } else {
    for (let i = 0; i < 32; i++) {
      if ((v.weapon | 0) & (1 << i)) {
        MSG_WriteByte(msg, i);
        break;
      }
    }
  }
}

// src/server/sv_main.ts's SV_StartSound, message body only (the precache
// lookup and the three Sys_Error range checks are not part of the codec).
function seedWriteSound(datagram: SizeBuf, ent: number, channel: number, sound_num: number, volume: number, attenuation: number, origin: Vec3): void {
  const channelBits = (ent << 3) | channel;

  let field_mask = 0;
  if (volume !== DEFAULT_SOUND_PACKET_VOLUME) field_mask |= SND_VOLUME;
  if (attenuation !== DEFAULT_SOUND_PACKET_ATTENUATION) field_mask |= SND_ATTENUATION;

  // directed messages go only to the entity the are targeted on
  MSG_WriteByte(datagram, SvcOpsT.svc_sound);
  MSG_WriteByte(datagram, field_mask);
  if (field_mask & SND_VOLUME) MSG_WriteByte(datagram, volume);
  if (field_mask & SND_ATTENUATION) MSG_WriteByte(datagram, attenuation * 64);
  MSG_WriteShort(datagram, channelBits);
  MSG_WriteByte(datagram, sound_num);
  for (let i = 0; i < 3; i++) MSG_WriteCoord(datagram, origin[i]);
}

// src/progs/pr_cmds.ts's PF_makestatic, message body only (the ED_Free is not
// part of the codec).
function seedWriteStatic(signon: SizeBuf, modelindex: number, frame: number, colormap: number, skin: number, origin: Vec3, angles: Vec3): void {
  MSG_WriteByte(signon, SvcOpsT.svc_spawnstatic);

  MSG_WriteByte(signon, modelindex);

  MSG_WriteByte(signon, frame);
  MSG_WriteByte(signon, colormap);
  MSG_WriteByte(signon, skin);
  for (let i = 0; i < 3; i++) {
    MSG_WriteCoord(signon, origin[i]);
    MSG_WriteAngle(signon, angles[i]);
  }
}

// src/progs/pr_cmds.ts's PF_ambientsound, message body only.
function seedWriteStaticSound(signon: SizeBuf, pos: Vec3, soundnum: number, vol: number, attenuation: number): void {
  MSG_WriteByte(signon, SvcOpsT.svc_spawnstaticsound);
  for (let i = 0; i < 3; i++) MSG_WriteCoord(signon, pos[i]);

  MSG_WriteByte(signon, soundnum);

  MSG_WriteByte(signon, vol * 255);
  MSG_WriteByte(signon, attenuation * 64);
}

//============================================================================
// A deterministic generator, so the comparison covers a wide field of values
// without a snapshot and without a different set on every run.

let rngState = 0x2f6e2b1;
function rnd(): number {
  // xorshift32
  rngState ^= rngState << 13;
  rngState >>>= 0;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  rngState >>>= 0;
  return rngState / 0x100000000;
}
function rndCoord(): number {
  return Math.round((rnd() * 8192 - 4096) * 8) / 8;
}
function rndAngle(): number {
  return Math.round(rnd() * 360);
}
function rndByte(): number {
  return Math.floor(rnd() * 256);
}

function v3(a: number, b: number, c: number): Vec3 {
  const v = vec3();
  v[0] = a;
  v[1] = b;
  v[2] = c;
  return v;
}

//============================================================================

describe("nq15 entity updates are byte-identical to the seed's", () => {
  test("500 generated entities, plus the delta edge cases", () => {
    const cases: Array<{ e: number; v: SeedEntVars; b: EntityStateT }> = [];

    for (let i = 0; i < 500; i++) {
      const b = new EntityStateT();
      b.origin[0] = rndCoord();
      b.origin[1] = rndCoord();
      b.origin[2] = rndCoord();
      b.angles[0] = rndAngle();
      b.angles[1] = rndAngle();
      b.angles[2] = rndAngle();
      b.modelindex = rndByte();
      b.frame = rndByte();
      b.colormap = rndByte();
      b.skin = rndByte();
      b.effects = rndByte();

      // Half the entities sit exactly on their baseline, half move off it, so
      // both sides of every `!==` and of the +-0.1 origin window are exercised.
      const drift = i % 2 === 0 ? 0 : 1;
      const v: SeedEntVars = {
        origin: v3(b.origin[0] + drift * 8, b.origin[1], b.origin[2] - drift * 3.5),
        angles: v3(b.angles[0], drift ? (b.angles[1] + 45) % 360 : b.angles[1], b.angles[2]),
        movetype: i % 5 === 0 ? SEED_MOVETYPE_STEP : 3,
        colormap: drift ? (b.colormap + 1) & 0xff : b.colormap,
        skin: b.skin,
        frame: drift ? (b.frame + 2) & 0xff : b.frame,
        effects: b.effects,
        modelindex: drift ? (b.modelindex + 3) & 0xff : b.modelindex,
      };
      cases.push({ e: i < 250 ? i + 1 : i + 260, v, b }); // both sides of U_LONGENTITY
    }

    // The +-0.1 origin window: exactly on it, just inside, just outside.
    for (const miss of [0, 0.05, 0.1, 0.100001, -0.1, -0.2, 12.75]) {
      const b = new EntityStateT();
      b.modelindex = 7;
      const v: SeedEntVars = {
        origin: v3(miss, 0, 0),
        angles: v3(0, 0, 0),
        movetype: 3,
        colormap: 0,
        skin: 0,
        frame: 0,
        effects: 0,
        modelindex: 7,
      };
      cases.push({ e: 1, v, b });
    }

    // A QuakeC float that is not an integer, so both encoders truncate it the
    // same way through MSG_WriteByte's `& 0xff`.
    {
      const b = new EntityStateT();
      const v: SeedEntVars = {
        origin: v3(0, 0, 0),
        angles: v3(0, 0, 0),
        movetype: 3,
        colormap: 3.5,
        skin: 0.5,
        frame: 12.9,
        effects: 8.25,
        modelindex: 2.75,
      };
      cases.push({ e: 42, v, b });
    }

    for (const c of cases) {
      const seeded = buf();
      seedWriteEntityUpdate(seeded, c.e, c.v, c.b);

      const u = new EntityUpdateT();
      u.origin[0] = c.v.origin[0];
      u.origin[1] = c.v.origin[1];
      u.origin[2] = c.v.origin[2];
      u.angles[0] = c.v.angles[0];
      u.angles[1] = c.v.angles[1];
      u.angles[2] = c.v.angles[2];
      u.modelindex = c.v.modelindex;
      u.frame = c.v.frame;
      u.colormap = c.v.colormap;
      u.skin = c.v.skin;
      u.effects = c.v.effects;
      u.movetypeStep = c.v.movetype === SEED_MOVETYPE_STEP;
      u.baseline = c.b;

      const codec = buf();
      nq15Codec.writeEntityUpdate(codec, c.e, u, 0);

      expect(bytes(codec)).toEqual(bytes(seeded));
    }

    expect(cases.length).toBe(508);
  });
});

describe("nq15 baselines are byte-identical to the seed's", () => {
  test("300 generated baselines", () => {
    for (let i = 0; i < 300; i++) {
      const b = new EntityStateT();
      b.origin[0] = rndCoord();
      b.origin[1] = rndCoord();
      b.origin[2] = rndCoord();
      b.angles[0] = rndAngle();
      b.angles[1] = rndAngle();
      b.angles[2] = rndAngle();
      // The seed's MAX_MODELS was 256, so a baseline modelindex or frame past
      // 255 was unreachable; the whole reachable range is covered here, and
      // the out-of-range case is a documented nq15 change tested separately in
      // test/protocol_codec.test.ts.
      b.modelindex = rndByte();
      b.frame = rndByte();
      b.colormap = rndByte();
      b.skin = rndByte();

      const copy = new EntityStateT();
      copy.copyFrom(b);

      const seeded = buf();
      seedWriteBaseline(seeded, i, b);

      const codec = buf();
      nq15Codec.writeBaseline(codec, i, copy, 0);

      expect(bytes(codec)).toEqual(bytes(seeded));
    }
  });
});

describe("nq15 clientdata is byte-identical to the seed's", () => {
  test("400 generated frames, plus the DEFAULT_VIEWHEIGHT and standard_quake edges", () => {
    const cases: SeedClientVars[] = [];

    for (let i = 0; i < 400; i++) {
      cases.push({
        view_ofs2: i % 3 === 0 ? DEFAULT_VIEWHEIGHT : Math.floor(rnd() * 60) - 30,
        idealpitch: i % 4 === 0 ? 0 : Math.floor(rnd() * 60) - 30,
        items: (rnd() * 0xffffffff) | 0,
        flagsOnGround: i % 2 === 0,
        waterlevel: i % 3,
        punchangle: v3(i % 5 === 0 ? 0 : -4, 0, i % 7 === 0 ? 3 : 0),
        velocity: v3(i % 2 ? 320 : 0, i % 3 ? -160 : 0, 0),
        weaponframe: i % 6 === 0 ? 0 : rndByte(),
        armorvalue: i % 8 === 0 ? 0 : rndByte(),
        weaponmodelIndex: rndByte(),
        health: Math.floor(rnd() * 300) - 50,
        currentammo: rndByte(),
        ammo_shells: rndByte(),
        ammo_nails: rndByte(),
        ammo_rockets: rndByte(),
        ammo_cells: rndByte(),
        // The one clientdata field the codec no longer encodes the way the
        // seed did is a zero `.weapon` with standard_quake off, where the seed
        // (WinQuake's and Ironwail's form) wrote no byte at all: see nq15.ts's
        // header and test/protocol_codec.test.ts. These cases pair every
        // non-standard_quake frame with a weapon that has a bit set, so the
        // whole range the seed and the codec still share is covered here.
        weapon: i % 2 ? 1 << i % 32 : rndByte(),
        standardQuake: i % 2 === 0,
      });
    }

    // A fractional armorvalue and weaponframe: the seed tested the raw
    // QuakeC float for truthiness, so 0.5 sets the bit even though the byte
    // it writes is 0. The codec must do the same.
    cases.push({
      view_ofs2: 22,
      idealpitch: 0,
      items: 0,
      flagsOnGround: false,
      waterlevel: 0,
      punchangle: v3(0, 0, 0),
      velocity: v3(0, 0, 0),
      weaponframe: 0.5,
      armorvalue: 0.5,
      weaponmodelIndex: 1,
      health: 1.5,
      currentammo: 2.5,
      ammo_shells: 0,
      ammo_nails: 0,
      ammo_rockets: 0,
      ammo_cells: 0,
      weapon: 0.5,
      standardQuake: true,
    });

    for (const v of cases) {
      const seeded = buf();
      seedWriteClientdata(seeded, v);

      const cd = new ClientdataT();
      cd.viewheight = v.view_ofs2;
      cd.idealpitch = v.idealpitch;
      cd.punchangle[0] = v.punchangle[0];
      cd.punchangle[1] = v.punchangle[1];
      cd.punchangle[2] = v.punchangle[2];
      cd.velocity[0] = v.velocity[0];
      cd.velocity[1] = v.velocity[1];
      cd.velocity[2] = v.velocity[2];
      cd.items = v.items;
      cd.onground = v.flagsOnGround;
      cd.inwater = v.waterlevel >= 2;
      cd.weaponframe = v.weaponframe;
      cd.armorvalue = v.armorvalue;
      cd.weaponmodelindex = v.weaponmodelIndex;
      cd.health = v.health;
      cd.currentammo = v.currentammo;
      cd.ammo_shells = v.ammo_shells;
      cd.ammo_nails = v.ammo_nails;
      cd.ammo_rockets = v.ammo_rockets;
      cd.ammo_cells = v.ammo_cells;
      cd.weapon = v.weapon;
      cd.standardQuake = v.standardQuake;

      const codec = buf();
      nq15Codec.writeClientdata(codec, cd, 0);

      expect(bytes(codec)).toEqual(bytes(seeded));
    }

    expect(cases.length).toBe(401);
  });
});

describe("nq15 sounds, statics and ambient sounds are byte-identical to the seed's", () => {
  test("200 generated sounds", () => {
    for (let i = 0; i < 200; i++) {
      const ent = Math.floor(rnd() * 600);
      const channel = i % 8;
      const soundNum = 1 + Math.floor(rnd() * 254);
      const volume = i % 3 === 0 ? DEFAULT_SOUND_PACKET_VOLUME : 1 + Math.floor(rnd() * 254);
      const attenuation = i % 4 === 0 ? DEFAULT_SOUND_PACKET_ATTENUATION : rnd() * 4;
      const origin = v3(rndCoord(), rndCoord(), rndCoord());

      const seeded = buf();
      seedWriteSound(seeded, ent, channel, soundNum, volume, attenuation, origin);

      const s = new SoundMessageT();
      s.ent = ent;
      s.channel = channel;
      s.soundNum = soundNum;
      s.volume = volume;
      s.attenuation = attenuation;
      s.origin[0] = origin[0];
      s.origin[1] = origin[1];
      s.origin[2] = origin[2];

      const codec = buf();
      expect(nq15Codec.writeSound(codec, s, 0)).toBe(true);
      expect(bytes(codec)).toEqual(bytes(seeded));
    }
  });

  test("200 generated static entities", () => {
    for (let i = 0; i < 200; i++) {
      const modelindex = rndByte();
      const frame = rndByte();
      const colormap = rndByte();
      const skin = rndByte();
      const origin = v3(rndCoord(), rndCoord(), rndCoord());
      const angles = v3(rndAngle(), rndAngle(), rndAngle());

      const seeded = buf();
      seedWriteStatic(seeded, modelindex, frame, colormap, skin, origin, angles);

      const state = new EntityStateT();
      state.modelindex = modelindex;
      state.frame = frame;
      state.colormap = colormap;
      state.skin = skin;
      state.origin[0] = origin[0];
      state.origin[1] = origin[1];
      state.origin[2] = origin[2];
      state.angles[0] = angles[0];
      state.angles[1] = angles[1];
      state.angles[2] = angles[2];

      const codec = buf();
      expect(nq15Codec.writeStatic(codec, state, 0)).toBe(true);
      expect(bytes(codec)).toEqual(bytes(seeded));
    }
  });

  test("200 generated ambient sounds", () => {
    for (let i = 0; i < 200; i++) {
      const pos = v3(rndCoord(), rndCoord(), rndCoord());
      const soundnum = Math.floor(rnd() * 256);
      const vol = rnd();
      const atten = rnd() * 4;

      const seeded = buf();
      seedWriteStaticSound(seeded, pos, soundnum, vol, atten);

      const codec = buf();
      expect(nq15Codec.writeStaticSound(codec, pos, soundnum, vol, atten, 0)).toBe(true);
      expect(bytes(codec)).toEqual(bytes(seeded));
    }
  });
});
