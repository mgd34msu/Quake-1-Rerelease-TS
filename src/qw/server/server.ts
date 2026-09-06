/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/server/server.h (GNU GPL v2 or later).

server.h -- QuakeWorld server's own `server_t`/`client_t`/`server_static_t`
and friends. Diffed field-by-field against src/server/server.ts (WinQuake);
every difference below is real (checked against both C headers, not just
this port's earlier TS), not a guess:

- `server_state_t` gains `ss_dead` (no map loaded) before `ss_loading`/
  `ss_active` -- WinQuake's only has the latter two.
- `server_t` drops `loadgame` (QW never "handles connections specially" the
  way WinQuake's single-player load path does) and `max_edicts` (no such
  field in QW's struct; `MAX_EDICTS` from bothdefs.ts is used directly by
  whichever unit needs a bound). It gains `model_player_checksum`/
  `eyes_player_checksum` (anti-cheat model hash checks), `pvs`/`phs`
  (fully expanded/decompressed visibility, computed per frame instead of
  per-client), a `multicast`/`multicast_buf` sizebuf (SV_Multicast's
  scratch buffer, new in QW), a `master`/`master_buf` sizebuf (heartbeat/log
  packet building), and replaces the flat `signon`/`signon_buf[8192]` pair
  with `signon` plus `num_signon_buffers`/`signon_buffer_size[]`/
  `signon_buffers[MAX_SIGNON_BUFFERS][MAX_DATAGRAM]` (large levels split
  their signon across up to `MAX_SIGNON_BUFFERS` packets instead of one big
  buffer).
- `client_state_t` (cs_free/cs_zombie/cs_connected/cs_spawned) replaces
  WinQuake's four separate booleans (`active`/`spawned`/`dropasap` folded
  into one state enum; `sendsignon` stays a separate field). `client_t`
  drops `wishdir` (SV_Physics_Client computes it locally in QW, not stored)
  and the `ping_times[NUM_PING_TIMES]`/`num_pings` pair (SV_CalcPing reads
  `frames[].ping_time` instead) -- `NUM_PING_TIMES` itself is not ported,
  it has no QW use. It gains: `spectator`, `sendinfo`, `lastnametime`/
  `lastnamecount`, `checksum`, `drop`, `lossage`, `userid`/`userinfo`
  (QW's userinfo-string client identity, replacing WinQuake's bare `name`,
  which QW keeps too as a derived field), `oldbuttons`, `maxspeed`/
  `entgravity` (per-client prediction overrides), `messagelevel`, a
  `backbuf`/`num_backbuf`/`backbuf_size[]`/`backbuf_data[][]` reliable-
  message back-buffer group (`MAX_BACK_BUFFERS`, new), `connection_started`/
  `send_message`, `stats[MAX_CL_STATS]` (server-side shadow of the client's
  stat bar, for delta-encoding `svc_updatestat`), `frames[UPDATE_BACKUP]`
  (per-client entity-update history for delta compression -- `client_frame_t`
  is new), `download`/`downloadsize`/`downloadcount` and their upload-side
  mirror `upload`/`uploadfn`/`snap_from`/`remote_snap`, `spec_track`,
  flood-protection state (`whensaid[10]`/`whensaidhead`/`lockedtill`),
  `upgradewarn`, and the network layer fields `chokecount`/`delta_sequence`/
  `netchan` (QW's own reliable/unreliable channel, replacing WinQuake's
  `netconnection: QsocketT`). `cmd`/`lastcmd` is QW's own `usercmd_t`
  (protocol.ts's `QwUsercmdT`), not server.ts's `UsercmdT`.
- `server_static_t` drops `maxclients`/`maxclientslimit`/`changelevel_issued`
  entirely (checked: not in the QW struct at all -- `sv_maxclients` is a
  cvar in QW, per sv_main.c, not a server_static_t field) and its
  `clients` array is a true fixed-size `client_t clients[MAX_CLIENTS]`
  embedded array (unlike WinQuake's `struct client_s *clients`, a
  Hunk-allocated pointer sized to a runtime `maxclients`) -- `svs.clients`
  below is prefilled with exactly `MAX_CLIENTS` (32) `ClientT` instances at
  module load, mirroring the C's always-fully-allocated struct array, rather
  than the empty-then-filled convention src/server/server.ts's `ServerStaticT`
  uses for its pointer-typed field. It gains `last_heartbeat`/
  `heartbeat_sequence`, `stats: svstats_t`, `info` (the serverinfo string,
  `MAX_SERVERINFO_STRING`), a two-buffer frag-log group (`logsequence`/
  `logtime`/`log[2]`/`log_buf[2][]`), and `challenges[MAX_CHALLENGES]`
  (connection anti-spoof challenges, new in QW).
- `MOVETYPE_*`/`SOLID_*`/`DEAD_*`/`DAMAGE_*` and `SPAWNFLAG_NOT_*` are
  byte-identical to WinQuake's (checked against both headers) and are
  re-exported from src/server/server.ts rather than redeclared.
- `FL_*`: `FLY`/`SWIM`/`CLIENT`/`INWATER`/`MONSTER`/`GODMODE`/`NOTARGET`/
  `ITEM`/`ONGROUND`/`PARTIALGROUND`/`WATERJUMP` are identical and
  re-exported. Bit 4 is `FL_GLIMPSE` in QW's header (not commented out, and
  not renamed `FL_CONVEYOR` the way WinQuake's is) -- defined fresh here
  under its QW name, same value, same "unrelated name for the same bit"
  situation src/server/server.ts's own file header already documents for
  `EF_*`. QW has no `FL_JUMPRELEASED` (4096) at all -- not ported.
- `EF_*`: only `EF_BRIGHTLIGHT`(4)/`EF_DIMLIGHT`(8) are defined in QW's
  header (`EF_BRIGHTFIELD`/`EF_MUZZLEFLASH` are `//`-commented out, same as
  in WinQuake's own header) -- re-exported from src/server/server.ts, which
  already defines all four; `EF_BRIGHTFIELD`/`EF_MUZZLEFLASH` are not
  re-exported here since QW itself does not define them.
- `MULTICAST_*` are plain `#define`s (not a `typedef enum` in the C) and
  become `export const`s per PORTING.md's `#define` rule, same idiom as
  `MOVETYPE_*`. `redirect_t` (`RD_NONE`/`RD_CLIENT`/`RD_PACKET`) *is* a
  `typedef enum` in the C (svonly.c's block) and becomes `RedirectT` below.
- `netadr_t`/`netchan_t` (client_t.netchan, client_t.snap_from,
  challenge_t.adr) are QW/client/net.h's types, ported as Q003's
  src/qw/net_udp.ts (`NetadrT`) and src/qw/net_chan.ts (`NetchanT`), both
  default-constructible classes landed concurrently with this unit --
  imported and instantiated directly below, embedded by value exactly as
  the C structs embed them (not pointer fields, so no `| null`).
- `FILE *download` / `FILE *upload`: src/common/common.ts's `FileHandle`
  (fd + pos) stands in, same idiom cvar.ts/host_cmd.ts already use for other
  `FILE *` fields; both start `null` (no file open).
- The `sv_main.c`/`sv_init.c`/`sv_phys.c`/`sv_send.c`/`sv_user.c`/`svonly.c`/
  `sv_ccmds.c`/`sv_ents.c`/`sv_nchan.c` function prototype blocks at the
  bottom of server.h are not declared here -- they belong to the later units
  named in each comment (Q014-Q017), exactly as src/server/server.ts's own
  file header defers WinQuake's `SV_*` prototypes.
- `extern cvar_t sv_mintic, sv_maxtic, sv_maxspeed, spawn, teamplay,
  deathmatch, fraglimit, timelimit;`, `extern netadr_t master_adr[MAX_MASTERS];`,
  `extern char localmodels[MAX_MODELS][5];`, `extern char
  localinfo[MAX_LOCALINFO_STRING+1];`, `extern int host_hunklevel;`,
  `extern FILE *sv_logfile, *sv_fraglogfile;`: all sv_main.c's/sv_ccmds.c's
  own globals, not ported here -- same deferral as qwsvdef.ts's host_* note.
  `MAX_MASTERS` itself is declared by this header (not sv_main.c) and is
  exported below even though the array that uses it is not.
*/

import type { ModelT } from "../../common/model";
import { SizeBuf } from "../../common/sizebuf";
import type { FileHandle } from "../../common/common";
import { NetchanT } from "../net_chan";
import { NetadrT } from "../net_udp";
import { MAX_MODELS, MAX_SOUNDS, MAX_LIGHTSTYLES, MAX_CL_STATS, MAX_DATAGRAM, MAX_MSGLEN } from "../bothdefs";
import { MAX_CLIENTS, UPDATE_BACKUP, PacketEntitiesT, QwUsercmdT } from "../protocol";
import type { QwEdictT } from "./progs";
import {
  MOVETYPE_NONE,
  MOVETYPE_ANGLENOCLIP,
  MOVETYPE_ANGLECLIP,
  MOVETYPE_WALK,
  MOVETYPE_STEP,
  MOVETYPE_FLY,
  MOVETYPE_TOSS,
  MOVETYPE_PUSH,
  MOVETYPE_NOCLIP,
  MOVETYPE_FLYMISSILE,
  MOVETYPE_BOUNCE,
  SOLID_NOT,
  SOLID_TRIGGER,
  SOLID_BBOX,
  SOLID_SLIDEBOX,
  SOLID_BSP,
  DEAD_NO,
  DEAD_DYING,
  DEAD_DEAD,
  DAMAGE_NO,
  DAMAGE_YES,
  DAMAGE_AIM,
  FL_FLY,
  FL_SWIM,
  FL_CLIENT,
  FL_INWATER,
  FL_MONSTER,
  FL_GODMODE,
  FL_NOTARGET,
  FL_ITEM,
  FL_ONGROUND,
  FL_PARTIALGROUND,
  FL_WATERJUMP,
  EF_BRIGHTLIGHT,
  EF_DIMLIGHT,
  SPAWNFLAG_NOT_EASY,
  SPAWNFLAG_NOT_MEDIUM,
  SPAWNFLAG_NOT_HARD,
  SPAWNFLAG_NOT_DEATHMATCH,
  NUM_SPAWN_PARMS,
} from "../../server/server";

export {
  MOVETYPE_NONE,
  MOVETYPE_ANGLENOCLIP,
  MOVETYPE_ANGLECLIP,
  MOVETYPE_WALK,
  MOVETYPE_STEP,
  MOVETYPE_FLY,
  MOVETYPE_TOSS,
  MOVETYPE_PUSH,
  MOVETYPE_NOCLIP,
  MOVETYPE_FLYMISSILE,
  MOVETYPE_BOUNCE,
  SOLID_NOT,
  SOLID_TRIGGER,
  SOLID_BBOX,
  SOLID_SLIDEBOX,
  SOLID_BSP,
  DEAD_NO,
  DEAD_DYING,
  DEAD_DEAD,
  DAMAGE_NO,
  DAMAGE_YES,
  DAMAGE_AIM,
  FL_FLY,
  FL_SWIM,
  FL_CLIENT,
  FL_INWATER,
  FL_MONSTER,
  FL_GODMODE,
  FL_NOTARGET,
  FL_ITEM,
  FL_ONGROUND,
  FL_PARTIALGROUND,
  FL_WATERJUMP,
  EF_BRIGHTLIGHT,
  EF_DIMLIGHT,
  SPAWNFLAG_NOT_EASY,
  SPAWNFLAG_NOT_MEDIUM,
  SPAWNFLAG_NOT_HARD,
  SPAWNFLAG_NOT_DEATHMATCH,
  NUM_SPAWN_PARMS,
};

// QW's own name for the same bit WinQuake calls FL_CONVEYOR -- see file header.
export const FL_GLIMPSE = 4;

export const MAX_MASTERS = 8; // max recipients for heartbeat packets; see file header

export const MAX_SIGNON_BUFFERS = 8;

//============================================================================

export enum ServerStateT {
  ss_dead = 0, // no map loaded
  ss_loading = 1, // spawning level edicts
  ss_active = 2, // actively running
}
// some qc commands are only valid before the server has finished
// initializing (precache commands, static sounds / objects, etc)

function makeArray<T>(n: number, make: () => T): T[] {
  const a: T[] = new Array<T>(n);
  for (let i = 0; i < n; i++) a[i] = make();
  return a;
}

export class ServerT {
  active = false; // false when server is going down
  state: ServerStateT = ServerStateT.ss_dead; // precache commands are only valid during load

  time = 0;

  lastcheck = 0; // used by PF_checkclient
  lastchecktime = 0; // for monster ai

  paused = false; // are we paused?

  // check player/eyes models for hacks
  model_player_checksum = 0; // unsigned
  eyes_player_checksum = 0; // unsigned

  name = ""; // map name
  modelname = ""; // maps/<name>.bsp, for model_precache[0]
  worldmodel: ModelT | null = null;
  model_precache: Array<string | null> = new Array<string | null>(MAX_MODELS).fill(null); // NULL terminated
  sound_precache: Array<string | null> = new Array<string | null>(MAX_SOUNDS).fill(null); // NULL terminated
  lightstyles: string[] = new Array<string>(MAX_LIGHTSTYLES).fill("");
  models: Array<ModelT | null> = new Array<ModelT | null>(MAX_MODELS).fill(null);

  num_edicts = 0; // increases towards MAX_EDICTS
  edicts: QwEdictT[] = []; // can NOT be array indexed, because
  // edict_t is variable sized, but can
  // be used to reference the world ent

  pvs: Uint8Array | null = null; // fully expanded and decompressed
  phs: Uint8Array | null = null;

  // added to every client's unreliable buffer each frame, then cleared
  datagram: SizeBuf = new SizeBuf();
  datagram_buf: Uint8Array = new Uint8Array(MAX_DATAGRAM);

  // added to every client's reliable buffer each frame, then cleared
  reliable_datagram: SizeBuf = new SizeBuf();
  reliable_datagram_buf: Uint8Array = new Uint8Array(MAX_MSGLEN);

  // used to send a message to a set of clients
  multicast: SizeBuf = new SizeBuf();
  multicast_buf: Uint8Array = new Uint8Array(MAX_MSGLEN);

  // used for building log packets
  master: SizeBuf = new SizeBuf();
  master_buf: Uint8Array = new Uint8Array(MAX_DATAGRAM);

  // the signon buffer will be sent to each client as they connect
  // includes the entity baselines, the static entities, etc
  // large levels will have >MAX_DATAGRAM sized signons, so
  // multiple signon messages are kept
  signon: SizeBuf = new SizeBuf();
  num_signon_buffers = 0;
  signon_buffer_size: number[] = new Array<number>(MAX_SIGNON_BUFFERS).fill(0);
  signon_buffers: Uint8Array[] = makeArray(MAX_SIGNON_BUFFERS, () => new Uint8Array(MAX_DATAGRAM));

  clear(): void {
    this.active = false;
    this.state = ServerStateT.ss_dead;
    this.time = 0;
    this.lastcheck = 0;
    this.lastchecktime = 0;
    this.paused = false;
    this.model_player_checksum = 0;
    this.eyes_player_checksum = 0;
    this.name = "";
    this.modelname = "";
    this.worldmodel = null;
    this.model_precache = new Array<string | null>(MAX_MODELS).fill(null);
    this.sound_precache = new Array<string | null>(MAX_SOUNDS).fill(null);
    this.lightstyles = new Array<string>(MAX_LIGHTSTYLES).fill("");
    this.models = new Array<ModelT | null>(MAX_MODELS).fill(null);
    this.num_edicts = 0;
    this.edicts = [];
    this.pvs = null;
    this.phs = null;
    this.datagram = new SizeBuf();
    this.datagram_buf = new Uint8Array(MAX_DATAGRAM);
    this.reliable_datagram = new SizeBuf();
    this.reliable_datagram_buf = new Uint8Array(MAX_MSGLEN);
    this.multicast = new SizeBuf();
    this.multicast_buf = new Uint8Array(MAX_MSGLEN);
    this.master = new SizeBuf();
    this.master_buf = new Uint8Array(MAX_DATAGRAM);
    this.signon = new SizeBuf();
    this.num_signon_buffers = 0;
    this.signon_buffer_size = new Array<number>(MAX_SIGNON_BUFFERS).fill(0);
    this.signon_buffers = makeArray(MAX_SIGNON_BUFFERS, () => new Uint8Array(MAX_DATAGRAM));
  }
}

//============================================================================

export enum ClientStateT {
  cs_free = 0, // can be reused for a new connection
  cs_zombie = 1, // client has been disconnected, but don't reuse
  // connection for a couple seconds
  cs_connected = 2, // has been assigned to a client_t, but not in game yet
  cs_spawned = 3, // client is fully in game
}

export class ClientFrameT {
  // received from client

  // reply
  senttime = 0; // double
  ping_time = 0; // float
  entities: PacketEntitiesT = new PacketEntitiesT();
}

export const MAX_BACK_BUFFERS = 4;

export class ClientT {
  state: ClientStateT = ClientStateT.cs_free;

  spectator = 0; // non-interactive

  sendinfo = false; // at end of frame, send info to all
  // this prevents malicious multiple broadcasts
  lastnametime = 0; // time of last name change
  lastnamecount = 0; // time of last name change
  checksum = 0; // unsigned; checksum for calcs
  drop = false; // lose this guy next opportunity
  lossage = 0; // loss percentage

  userid = 0; // identifying number
  userinfo = ""; // infostring, MAX_INFO_STRING

  lastcmd: QwUsercmdT = new QwUsercmdT(); // for filling in big drops and partial predictions
  localtime = 0; // of last message
  oldbuttons = 0;

  maxspeed = 0; // localized maxspeed
  entgravity = 0; // localized ent gravity

  edict: QwEdictT | null = null; // EDICT_NUM(clientnum+1)
  name = ""; // for printing to other people; extracted from userinfo
  messagelevel = 0; // for filtering printed messages

  // the datagram is written to after every frame, but only cleared
  // when it is sent out to the client. overflow is tolerated.
  datagram: SizeBuf = new SizeBuf();
  datagram_buf: Uint8Array = new Uint8Array(MAX_DATAGRAM);

  // back buffers for client reliable data
  backbuf: SizeBuf = new SizeBuf();
  num_backbuf = 0;
  backbuf_size: number[] = new Array<number>(MAX_BACK_BUFFERS).fill(0);
  backbuf_data: Uint8Array[] = makeArray(MAX_BACK_BUFFERS, () => new Uint8Array(MAX_MSGLEN));

  connection_started = 0; // or time of disconnect for zombies
  send_message = false; // set on frames a datagram arived on

  // spawn parms are carried from level to level
  spawn_parms: Float32Array = new Float32Array(NUM_SPAWN_PARMS);

  // client known data for deltas
  old_frags = 0;

  stats: Int32Array = new Int32Array(MAX_CL_STATS);

  frames: ClientFrameT[] = makeArray(UPDATE_BACKUP, () => new ClientFrameT()); // updates can be deltad from here

  download: FileHandle | null = null; // file being downloaded
  downloadsize = 0; // total bytes
  downloadcount = 0; // bytes sent

  spec_track = 0; // entnum of player tracking

  whensaid: Float64Array = new Float64Array(10); // JACK: For floodprots
  whensaidhead = 0; // Head value for floodprots
  lockedtill = 0;

  upgradewarn = false; // did we warn him?

  upload: FileHandle | null = null;
  uploadfn = "";
  snap_from: NetadrT = new NetadrT();
  remote_snap = false;

  //===== NETWORK ============
  chokecount = 0;
  delta_sequence = -1; // -1 = no compression
  netchan: NetchanT = new NetchanT();
}

// a client can leave the server in one of four ways:
// dropping properly by quiting or disconnecting
// timing out if no valid messages are received for timeout.value seconds
// getting kicked off by the server operator
// a program error, like an overflowed reliable buffer

//=============================================================================

export const STATFRAMES = 100;

export class SvstatsT {
  active = 0; // double
  idle = 0; // double
  count = 0;
  packets = 0;

  latched_active = 0; // double
  latched_idle = 0; // double
  latched_packets = 0;
}

// MAX_CHALLENGES is made large to prevent a denial
// of service attack that could cycle all of them
// out before legitimate users connected
export const MAX_CHALLENGES = 1024;

export class ChallengeT {
  adr: NetadrT = new NetadrT();
  challenge = 0;
  time = 0;
}

export class ServerStaticT {
  spawncount = 0; // number of servers spawned since start,
  // used to check late spawns
  clients: ClientT[] = makeArray(MAX_CLIENTS, () => new ClientT());
  serverflags = 0; // episode completion information

  last_heartbeat = 0; // double
  heartbeat_sequence = 0;
  stats: SvstatsT = new SvstatsT();

  info = ""; // MAX_SERVERINFO_STRING

  // log messages are used so that fraglog processes can get stats
  logsequence = 0; // the message currently being filled
  logtime = 0; // time of last swap
  log: SizeBuf[] = [new SizeBuf(), new SizeBuf()];
  log_buf: Uint8Array[] = [new Uint8Array(MAX_DATAGRAM), new Uint8Array(MAX_DATAGRAM)];

  challenges: ChallengeT[] = makeArray(MAX_CHALLENGES, () => new ChallengeT()); // to prevent invalid IPs from connecting
}

//=============================================================================

export enum MulticastT {
  MULTICAST_ALL = 0,
  MULTICAST_PHS = 1,
  MULTICAST_PVS = 2,

  MULTICAST_ALL_R = 3,
  MULTICAST_PHS_R = 4,
  MULTICAST_PVS_R = 5,
}
// svonly.c's redirect_t
export enum RedirectT {
  RD_NONE = 0,
  RD_CLIENT = 1,
  RD_PACKET = 2,
}

//============================================================================

export const svs = new ServerStaticT(); // persistant server info
export const sv = new ServerT(); // local server

// `client_t *host_client;` and `edict_t *sv_player;`: C globals reassigned to
// point at whatever client/edict is "current" (sv_main.c/sv_user.c/pr_cmds.c
// for qwsv). Same PORTING.md holder-with-setter ruling as src/server/server.ts.
export const svState: { host_client: ClientT | null; sv_player: QwEdictT | null } = {
  host_client: null,
  sv_player: null,
};
