/*
The Quake 1 binding of src/lib/bot_brain's `BotWorldT`: the brain's whole
view of a running NetQuake server, built out of `sv.edicts`.

Everything the brain asks for comes out of entvars (`ent.v`), world.ts's
SV_Move / SV_PointContents, and the bots/*.txt tables loaded by
bot_data.ts. Nothing here decides anything; it answers questions.

HEARING. The 2021 engine feeds its bots real sound events. This binding has
no hook into SV_StartSound (sv_main.ts is another concern's file and this
unit's brief limits its edits to the bot client slot), so it derives the
same signal from state the server already publishes: EF_MUZZLEFLASH is set
on an entity for exactly the frame it fires, and a player moving faster than
a walk is making footstep noise. Both are visible in entvars, both last
exactly as long as the event does, and both are what `senses.sound_range` is
scaled against. Documented here as an addition rather than left implicit.
*/

import { EDICT_NUM, PR_GetString, pr, type EdictT } from "../progs/progs";
import { EF_MUZZLEFLASH, FL_MONSTER, MOVETYPE_NOCLIP, SOLID_NOT, SOLID_TRIGGER, sv, svs } from "../server/server";
import { MOVE_NOMONSTERS, MOVE_NORMAL, SV_Move, SV_PointContents } from "../server/world";
import { CONTENTS_EMPTY, CONTENTS_LAVA, CONTENTS_SKY, CONTENTS_SLIME, CONTENTS_SOLID, CONTENTS_WATER } from "../common/bspfile";
import { vec3, type Vec3 } from "../common/mathlib";
import { IT_INVISIBILITY, IT_INVULNERABILITY, IT_KEY1, IT_KEY2 } from "../common/quakedef";
import type { NavGraph } from "../lib/bot_brain/nav_graph";
import { bvec, type BotVec3 } from "../lib/bot_brain/math";
import { BotContents, BotEntityKind, type BotEntityT, type BotSelfT, type BotSoundT, type BotTraceT, type BotWorldT } from "../lib/bot_brain/world";
import { Bot_Knowledge, Bot_Nav } from "./bot_data";

/** quakec/defs.qc:260 -- "mal: this will be set on bot players". */
export const FL_ISBOT = 8192;

/** Quake's walk speed; anything faster than this is audible as footsteps. */
const AUDIBLE_SPEED = 200;
/** How loud a muzzle flash is, as a multiplier on senses.sound_range. */
const GUNSHOT_LOUDNESS = 2;

export function toBotVec(v: Vec3): BotVec3 {
  return { x: v[0]!, y: v[1]!, z: v[2]! };
}

export function toEngineVec(v: BotVec3, out: Vec3 = vec3()): Vec3 {
  out[0] = v.x;
  out[1] = v.y;
  out[2] = v.z;
  return out;
}

function contentsToBot(contents: number): number {
  switch (contents) {
    case CONTENTS_SOLID:
      return BotContents.Solid;
    case CONTENTS_WATER:
      return BotContents.Water;
    case CONTENTS_SLIME:
      return BotContents.Slime;
    case CONTENTS_LAVA:
      return BotContents.Lava;
    case CONTENTS_SKY:
      return BotContents.Sky;
    case CONTENTS_EMPTY:
    default:
      return BotContents.Empty;
  }
}

function classnameOf(ent: EdictT): string {
  return ent.v.classname === 0 ? "" : PR_GetString(ent.v.classname);
}

/** True for a client slot that is an engine-driven bot: active, in the game, no socket. */
export function edictIsBot(ent: EdictT): boolean {
  return ((ent.v.flags | 0) & FL_ISBOT) !== 0;
}

function isClientEdict(ent: EdictT): boolean {
  return ent.index >= 1 && ent.index <= svs.maxclients;
}

//============================================================================

/**
 * One bot's view of the server. Constructed once per bot and re-pointed at
 * the same edict every frame; `beginFrame` is what refreshes the per-frame
 * caches so several `think()` queries in one frame agree with each other.
 */
export class BotServerWorld implements BotWorldT {
  private readonly edictIndex: number;
  private frameEntities: BotEntityT[] = [];
  private frameSounds: BotSoundT[] = [];
  private frameStamp = -1;
  private dt = 0.05;

  constructor(edictIndex: number) {
    this.edictIndex = edictIndex;
  }

  edict(): EdictT {
    return EDICT_NUM(this.edictIndex);
  }

  /** Called once per server frame before `think()`, with the frame length. */
  beginFrame(frametime: number): void {
    this.dt = frametime;
    this.frameStamp = -1;
  }

  time(): number {
    return sv.time;
  }

  frameTime(): number {
    return this.dt;
  }

  self(): BotSelfT {
    const ent = this.edict();
    const origin = toBotVec(ent.v.origin);
    const viewOfs = toBotVec(ent.v.view_ofs);
    return {
      id: this.edictIndex,
      origin,
      velocity: toBotVec(ent.v.velocity),
      viewAngles: toBotVec(ent.v.v_angle),
      eye: { x: origin.x + viewOfs.x, y: origin.y + viewOfs.y, z: origin.z + viewOfs.z },
      health: ent.v.health,
      armor: ent.v.armorvalue,
      items: ent.v.items | 0,
      ammo: {
        ammo_shells: ent.v.ammo_shells,
        ammo_nails: ent.v.ammo_nails,
        ammo_rockets: ent.v.ammo_rockets,
        ammo_cells: ent.v.ammo_cells,
      },
      currentWeapon: ent.v.weapon | 0,
      onGround: ((ent.v.flags | 0) & 512) !== 0, // FL_ONGROUND
      waterLevel: ent.v.waterlevel | 0,
      team: ent.v.team | 0,
      dead: ent.v.health <= 0 || ent.v.deadflag !== 0,
      hasProtection: hasProtection(ent),
      carryingObjective: carriesObjective(ent),
    };
  }

  traceLine(start: BotVec3, end: BotVec3): BotTraceT {
    const ent = this.edict();
    const trace = SV_Move(toEngineVec(start), vec3(), vec3(), toEngineVec(end), MOVE_NOMONSTERS, ent);
    return {
      fraction: trace.fraction,
      endpos: toBotVec(trace.endpos),
      startsolid: trace.startsolid,
      hitId: trace.ent === null ? -1 : trace.ent.index,
    };
  }

  traceBox(start: BotVec3, mins: BotVec3, maxs: BotVec3, end: BotVec3): BotTraceT {
    const ent = this.edict();
    const trace = SV_Move(toEngineVec(start), toEngineVec(mins), toEngineVec(maxs), toEngineVec(end), MOVE_NORMAL, ent);
    return {
      fraction: trace.fraction,
      endpos: toBotVec(trace.endpos),
      startsolid: trace.startsolid,
      hitId: trace.ent === null ? -1 : trace.ent.index,
    };
  }

  pointContents(p: BotVec3): number {
    return contentsToBot(SV_PointContents(toEngineVec(p)));
  }

  entities(): readonly BotEntityT[] {
    this.refresh();
    return this.frameEntities;
  }

  hearing(): readonly BotSoundT[] {
    this.refresh();
    return this.frameSounds;
  }

  nav(): NavGraph | null {
    return Bot_Nav();
  }

  //--------------------------------------------------------------------------

  private refresh(): void {
    if (this.frameStamp === sv.time) return;
    this.frameStamp = sv.time;

    const entities: BotEntityT[] = [];
    const sounds: BotSoundT[] = [];
    const knowledge = Bot_Knowledge();

    for (let i = 1; i < sv.num_edicts; i++) {
      const ent = EDICT_NUM(i);
      if (ent.free) continue;
      if (i === this.edictIndex) continue;

      const classname = classnameOf(ent);
      const flags = ent.v.flags | 0;

      let kind: number | null = null;
      if (isClientEdict(ent)) {
        const client = svs.clients[i - 1];
        if (client === undefined || !client.active || !client.spawned) continue;
        kind = BotEntityKind.Player;
      } else if ((flags & FL_MONSTER) !== 0) {
        kind = BotEntityKind.Monster;
      } else if (knowledge !== null && knowledge.item(classname) !== undefined) {
        // An item that has been taken goes SOLID_NOT and drops its model
        // until it respawns; the brain must not walk to those.
        if (ent.v.solid !== SOLID_TRIGGER || ent.v.modelindex === 0) continue;
        kind = BotEntityKind.Item;
      } else if (knowledge !== null && knowledge.interactionFor(classname, { spawnflags: ent.v.spawnflags | 0, hasHealth: ent.v.health > 0, hasTargetname: ent.v.targetname !== 0 }) !== null) {
        kind = BotEntityKind.Interactable;
      }
      if (kind === null) continue;

      const origin = toBotVec(ent.v.origin);
      const mins = toBotVec(ent.v.mins);
      const maxs = toBotVec(ent.v.maxs);
      const items = ent.v.items | 0;

      entities.push({
        id: i,
        kind,
        classname,
        origin,
        center: { x: origin.x + (mins.x + maxs.x) / 2, y: origin.y + (mins.y + maxs.y) / 2, z: origin.z + (mins.z + maxs.z) / 2 },
        head: { x: origin.x, y: origin.y, z: origin.z + maxs.z - 4 },
        feet: { x: origin.x, y: origin.y, z: origin.z + mins.z + 4 },
        velocity: toBotVec(ent.v.velocity),
        health: ent.v.health,
        team: ent.v.team | 0,
        dead: kind === BotEntityKind.Player || kind === BotEntityKind.Monster ? ent.v.health <= 0 || ent.v.deadflag !== 0 : false,
        invisible: (items & IT_INVISIBILITY) !== 0,
        waterLevel: ent.v.waterlevel | 0,
        isBot: edictIsBot(ent),
        spawnflags: ent.v.spawnflags | 0,
        hasHealth: ent.v.health > 0,
        hasTargetname: ent.v.targetname !== 0,
      });

      // See the file header: the two noise signals entvars already carries.
      if (kind === BotEntityKind.Player || kind === BotEntityKind.Monster) {
        if (((ent.v.effects | 0) & EF_MUZZLEFLASH) !== 0) {
          sounds.push({ origin, sourceId: i, time: sv.time, loudness: GUNSHOT_LOUDNESS });
        } else if (ent.v.movetype !== MOVETYPE_NOCLIP && ent.v.solid !== SOLID_NOT) {
          const v = ent.v.velocity;
          const speed = Math.sqrt(v[0]! * v[0]! + v[1]! * v[1]!);
          if (speed > AUDIBLE_SPEED) sounds.push({ origin, sourceId: i, time: sv.time, loudness: 1 });
        }
      }
    }

    this.frameEntities = entities;
    this.frameSounds = sounds;
  }
}

/**
 * True when the bot is carrying an objective. quakec_ctf/teamplay.qc's
 * TeamCaptureFlagTouch gives the carrier the other team's key bit
 * (item_flag_team1 carries IT_KEY2, item_flag_team2 carries IT_KEY1) and
 * takes both back on a capture, so `items` is the CTF progs' own statement
 * of who is holding a flag. No other id1 gameplay hands a key to a player in
 * a deathmatch level.
 */
export function carriesObjective(ent: EdictT): boolean {
  return ((ent.v.items | 0) & (IT_KEY1 | IT_KEY2)) !== 0;
}

/** True when the bot holds the Pentagram, which weapons.txt's electric-in-water rule exempts. */
export function hasProtection(ent: EdictT): boolean {
  return ((ent.v.items | 0) & IT_INVULNERABILITY) !== 0;
}

/** Whether the progs currently loaded declares a function of this name. */
export function progsHasFunction(name: string): boolean {
  for (const fn of pr.functions) if (PR_GetString(fn.s_name) === name) return true;
  return false;
}
