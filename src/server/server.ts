/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/server.h (GNU GPL v2 or later).

server.h -- types + the `sv`/`svs` singletons, and the shared movetype/solid/
deadflag/damage/flags/spawnflag/effect constants every server-side unit reads.

Deviations from PORTING.md / the C source:
- `server_static_t` -> `ServerStaticT`, `server_t` -> `ServerT`, `client_t` ->
  `ClientT`: classes with every field, per the "C structs -> class" rule.
  `server_t`'s `memset (&sv, 0, sizeof(sv))` (SV_SpawnServer, sv_main.c) is
  this class's `clear()`; `client_t` and `server_static_t` are never memset
  wholesale in the C (client_t's fields are cleared one at a time in
  SV_SpawnServer's `SV_AcceptClient`/host_client loop, out of this unit's
  scope) so neither gets a `clear()` here.
- `usercmd_t` is declared in client.h, not server.h, but server.h's
  `client_t.cmd` field needs the type and client.ts (a later unit) is not
  landed yet; ported here as `UsercmdT` per the unit brief, with client.ts
  expected to import it rather than redeclare it when it lands.
- `host_client` and `sv_player` are C globals reassigned to point at whatever
  edict/client is "current" (sv_main.c, pr_cmds.c, sv_user.c). Per PORTING.md
  ("C globals that are reassigned pointers... become fields on their owning
  singleton or a small exported holder with a setter") they become
  `svState.host_client` / `svState.sv_player` below rather than reassignable
  `export let` bindings, which cannot be reassigned through another module's
  import the way C's `extern client_t *host_client;` can.
- `extern cvar_t teamplay/skill/deathmatch/coop/fraglimit/timelimit;`,
  `extern jmp_buf host_abortserver;`, `extern double host_time;`, and every
  `void SV_*`/`qboolean SV_*` function prototype belong to sv_main.c/
  sv_phys.c/sv_move.c/sv_user.c/host.c and their own modules -- not ported
  here, per the unit brief.
- Dropped `#ifdef QUAKE2` blocks (never defined in a WinQuake build, per
  PORTING.md's "#ifdef... QUAKE2... take the portable path" rule):
  `server_t.startspot`, `MOVETYPE_BOUNCEMISSILE`/`MOVETYPE_FOLLOW`,
  `FL_FLASHLIGHT`/`FL_ARCHIVE_OVERRIDE`, `EF_DARKLIGHT`/`EF_DARKFIELD`/
  `EF_LIGHT`/`EF_NODRAW`, and the `SFL_*` server-flags block.
- `EF_BRIGHTFIELD`/`EF_MUZZLEFLASH`/`EF_BRIGHTLIGHT`/`EF_DIMLIGHT` are server.h's
  own "entity effects" defines. model.ts already exports an unrelated
  same-valued `EF_ROCKET`/`EF_GRENADE`/`EF_GIB`/`EF_ROTATE` group from model.h
  (both header files define effect bits for the same entvars_t.effects field,
  under different names, with the C's `#define` redefinition rule allowing
  the coincidental overlap) -- the two groups are unrelated names and neither
  is renamed here.
*/

import type { EdictT } from "../progs/progs";
import type { ModelT } from "../common/model";
import type { QsocketT } from "../common/net";
import { SizeBuf } from "../common/sizebuf";
import { MAX_DATAGRAM, MAX_LIGHTSTYLES, MAX_MODELS, MAX_MSGLEN, MAX_SOUNDS } from "../common/quakedef";
import type { Vec3 } from "../common/mathlib";
import { vec3 } from "../common/mathlib";

//============================================================================

export enum ServerStateT {
  ss_loading = 0,
  ss_active = 1,
}

export class ServerT {
  active = false; // false if only a net client

  paused = false;
  loadgame = false; // handle connections specially

  time = 0;

  lastcheck = 0; // used by PF_checkclient
  lastchecktime = 0;

  name = ""; // map name
  modelname = ""; // maps/<name>.bsp, for model_precache[0]
  worldmodel: ModelT | null = null;
  model_precache: Array<string | null> = new Array<string | null>(MAX_MODELS).fill(null); // NULL terminated
  models: Array<ModelT | null> = new Array<ModelT | null>(MAX_MODELS).fill(null);
  sound_precache: Array<string | null> = new Array<string | null>(MAX_SOUNDS).fill(null); // NULL terminated
  lightstyles: string[] = new Array<string>(MAX_LIGHTSTYLES).fill("");
  num_edicts = 0;
  max_edicts = 0;
  edicts: EdictT[] = []; // can NOT be array indexed, because
  // edict_t is variable sized, but can
  // be used to reference the world ent
  state: ServerStateT = ServerStateT.ss_loading; // some actions are only valid during load

  datagram: SizeBuf = new SizeBuf();
  datagram_buf: Uint8Array = new Uint8Array(MAX_DATAGRAM);

  reliable_datagram: SizeBuf = new SizeBuf(); // copied to all clients at end of frame
  reliable_datagram_buf: Uint8Array = new Uint8Array(MAX_DATAGRAM);

  signon: SizeBuf = new SizeBuf();
  signon_buf: Uint8Array = new Uint8Array(8192);

  clear(): void {
    this.active = false;
    this.paused = false;
    this.loadgame = false;
    this.time = 0;
    this.lastcheck = 0;
    this.lastchecktime = 0;
    this.name = "";
    this.modelname = "";
    this.worldmodel = null;
    this.model_precache = new Array<string | null>(MAX_MODELS).fill(null);
    this.models = new Array<ModelT | null>(MAX_MODELS).fill(null);
    this.sound_precache = new Array<string | null>(MAX_SOUNDS).fill(null);
    this.lightstyles = new Array<string>(MAX_LIGHTSTYLES).fill("");
    this.num_edicts = 0;
    this.max_edicts = 0;
    this.edicts = [];
    this.state = ServerStateT.ss_loading;
    this.datagram = new SizeBuf();
    this.datagram_buf = new Uint8Array(MAX_DATAGRAM);
    this.reliable_datagram = new SizeBuf();
    this.reliable_datagram_buf = new Uint8Array(MAX_DATAGRAM);
    this.signon = new SizeBuf();
    this.signon_buf = new Uint8Array(8192);
  }
}

export const NUM_PING_TIMES = 16;
export const NUM_SPAWN_PARMS = 16;

// client.h's usercmd_t -- see file header's deviation note.
export class UsercmdT {
  viewangles: Vec3 = vec3(); // intended velocities
  forwardmove = 0;
  sidemove = 0;
  upmove = 0;
}

export class ClientT {
  active = false; // false = client is free
  spawned = false; // false = don't send datagrams
  dropasap = false; // has been told to go to another level
  privileged = false; // can execute any host command
  sendsignon = false; // only valid before spawned

  last_message = 0; // reliable messages must be sent
  // periodically

  netconnection: QsocketT | null = null; // communications handle

  cmd: UsercmdT = new UsercmdT(); // movement
  wishdir: Vec3 = vec3(); // intended motion calced from cmd

  message: SizeBuf = new SizeBuf(); // can be added to at any time,
  // copied and clear once per frame
  msgbuf: Uint8Array = new Uint8Array(MAX_MSGLEN);
  edict: EdictT | null = null; // EDICT_NUM(clientnum+1)
  name = ""; // for printing to other people
  colors = 0;

  ping_times: Float32Array = new Float32Array(NUM_PING_TIMES);
  num_pings = 0; // ping_times[num_pings%NUM_PING_TIMES]

  // spawn parms are carried from level to level
  spawn_parms: Float32Array = new Float32Array(NUM_SPAWN_PARMS);

  // client known data for deltas
  old_frags = 0;
}

//============================================================================

export class ServerStaticT {
  maxclients = 0;
  maxclientslimit = 0;
  clients: ClientT[] = []; // [maxclients]
  serverflags = 0; // episode completion information
  changelevel_issued = false; // cleared when at SV_SpawnServer
}

//============================================================================
// edict->movetype values
export const MOVETYPE_NONE = 0; // never moves
export const MOVETYPE_ANGLENOCLIP = 1;
export const MOVETYPE_ANGLECLIP = 2;
export const MOVETYPE_WALK = 3; // gravity
export const MOVETYPE_STEP = 4; // gravity, special edge handling
export const MOVETYPE_FLY = 5;
export const MOVETYPE_TOSS = 6; // gravity
export const MOVETYPE_PUSH = 7; // no clip to world, push and crush
export const MOVETYPE_NOCLIP = 8;
export const MOVETYPE_FLYMISSILE = 9; // extra size to monsters
export const MOVETYPE_BOUNCE = 10;

// edict->solid values
export const SOLID_NOT = 0; // no interaction with other objects
export const SOLID_TRIGGER = 1; // touch on edge, but not blocking
export const SOLID_BBOX = 2; // touch on edge, block
export const SOLID_SLIDEBOX = 3; // touch on edge, but not an onground
export const SOLID_BSP = 4; // bsp clip, touch on edge, block

// edict->deadflag values
export const DEAD_NO = 0;
export const DEAD_DYING = 1;
export const DEAD_DEAD = 2;

export const DAMAGE_NO = 0;
export const DAMAGE_YES = 1;
export const DAMAGE_AIM = 2;

// edict->flags
export const FL_FLY = 1;
export const FL_SWIM = 2;
// #define	FL_GLIMPSE				4
export const FL_CONVEYOR = 4;
export const FL_CLIENT = 8;
export const FL_INWATER = 16;
export const FL_MONSTER = 32;
export const FL_GODMODE = 64;
export const FL_NOTARGET = 128;
export const FL_ITEM = 256;
export const FL_ONGROUND = 512;
export const FL_PARTIALGROUND = 1024; // not all corners are valid
export const FL_WATERJUMP = 2048; // player jumping out of water
export const FL_JUMPRELEASED = 4096; // for jump debouncing

// entity effects
export const EF_BRIGHTFIELD = 1;
export const EF_MUZZLEFLASH = 2;
export const EF_BRIGHTLIGHT = 4;
export const EF_DIMLIGHT = 8;

export const SPAWNFLAG_NOT_EASY = 256;
export const SPAWNFLAG_NOT_MEDIUM = 512;
export const SPAWNFLAG_NOT_HARD = 1024;
export const SPAWNFLAG_NOT_DEATHMATCH = 2048;

//============================================================================

export const svs = new ServerStaticT(); // persistant server info
export const sv = new ServerT(); // local server

// `client_t *host_client;` and `edict_t *sv_player;`: C globals reassigned to
// point at whatever client/edict is "current" in sv_main.c/sv_user.c/
// pr_cmds.c. See file header's deviation note.
export const svState: { host_client: ClientT | null; sv_player: EdictT | null } = {
  host_client: null,
  sv_player: null,
};
