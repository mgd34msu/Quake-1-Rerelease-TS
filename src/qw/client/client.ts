/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/client.h (GNU GPL v2 or later).

client.h -- the QuakeWorld-only members of the client's shared state.

Ruling (PORTING.md's QuakeWorld track, "Client state is a superset"): WinQuake's
`ClientStateT`/`ClientStaticT` (src/client/client.ts) keep every WinQuake field
and gain one `qw` member each, holding the fields QW's client_state_t/
client_static_t add that WinQuake's versions do not have. Every field already
present on the shared classes (movemessages, stats, item_gettime, faceanimtime,
cshifts/prev_cshifts, viewangles, time, pitchvel/nodrift/driftmove/laststop,
crouch, paused, intermission, completed_time, model_precache/sound_precache,
levelname, worldmodel, free_efrags, num_entities, num_statics, cdtrack, viewent,
demonum, demos, demorecording/demoplayback/timedemo, demofile,
td_lastframe/td_startframe/td_starttime) is read from `cl`/`cls` directly by QW
code too, not duplicated here.

This module imports nothing from src/client/client.ts (avoiding the import
cycle that a value import the other way already resolves) -- only
src/common/*, src/qw/protocol.ts (this track's own foundation module) and
src/client/vid.ts, which is a leaf module (no imports of its own) already used
the same way by src/client/client.ts's own `ScoreboardT.translations`.

Deviations from PORTING.md / the C source:
- `cactive_t` gains no new type here: PORTING.md's ruling appends QW's
  `ca_demostart`/`ca_onserver`/`ca_active` to WinQuake's `CactiveT`
  (src/client/client.ts) directly, after `ca_connected`, continuing the
  existing numbering (3, 4, 5). The C's own QW `cactive_t` enum order is
  `ca_disconnected, ca_demostart, ca_connected, ca_onserver, ca_active` (0-4) --
  a different order from WinQuake's `ca_dedicated, ca_disconnected,
  ca_connected` (0-2) that a single shared enum cannot reproduce for both
  trees at once. Ported QW code must compare `cls.state` against the named
  `CactiveT` members, never against a literal number, for this to be safe;
  this deviation is called out again on `CactiveT` itself in client.ts.
- `player_state_t.punchangle` is a single `float` (a view-kick magnitude), not
  the `vec3_t` WinQuake's `ClientStateT.punchangle` is. Since it lives inside
  `PlayerStateT` (per-player prediction state, a QW-only type with no
  WinQuake counterpart) there is no name collision with `cl.punchangle`; both
  exist side by side (`cl.punchangle: Vec3` and, per-player,
  `cl.qw.frames[i].playerstate[j].punchangle: number`).
- `MAX_SCOREBOARDNAME` is redefined locally by QW/client/client.h to 16 (for
  `player_info_t.name`), distinct from src/common/quakedef.ts's
  `MAX_SCOREBOARDNAME` (32, for WinQuake's unrelated `ScoreboardT.name`). Kept
  as a module-local constant here, not exported, so it cannot collide with the
  WinQuake one at any import site.
- `netchan_t netchan` (Q003's src/qw/net_chan.ts, not yet landed) is `unknown`
  here, the same forward-declaration idiom src/client/client.ts already uses
  for `SfxT` pending src/client/sound.ts. Follow-up: once net_chan.ts lands it
  should export the real `NetchanT` and `QwClientStaticExtT.netchan`'s type
  should become a re-export of it.
- `FILE *download` (client_static_t): src/common/common.ts's `FileHandle` is
  this port's `FILE*` stand-in (same idiom as `ClientStaticT.demofile`).
- `skin_t *skin` (player_info_t): skin.c (src/qw/client/skin.ts) has not
  landed. `unknown` here, same forward-declaration idiom as `netchan` above;
  a real `SkinT` re-export is skin.ts's follow-up.
- `char model_name[MAX_MODELS][MAX_QPATH]`/`char sound_name[MAX_SOUNDS][MAX_QPATH]`:
  ported as `string[]` (length MAX_MODELS/MAX_SOUNDS), each entry an empty
  string until CL_ParseModellist/CL_ParseSoundlist (cl_parse.ts, not yet
  landed) fill them in, mirroring a `char[][]` array of empty C strings.
- Dropped: nothing. Every QW-only field of `client_state_t`/`client_static_t`
  listed in client.h is ported below.
*/

import { type Vec3, vec3 } from "../../common/mathlib";
import type { FileHandle } from "../../common/common";
import { VID_GRADES } from "../../client/vid";
import { MAX_CLIENTS, PacketEntitiesT, QwEntityStateT, QwUsercmdT, UPDATE_BACKUP } from "../protocol";
import { MAX_EDICTS, MAX_MODELS, MAX_SOUNDS } from "../bothdefs";
import { NetchanT } from "../net_chan";
import { CacheUser } from "../../common/zone";

// QW/client/client.h: `#define MAX_SCOREBOARDNAME 16`, local to this header --
// see file header for why this is not exported.
const MAX_SCOREBOARDNAME = 16;

//
// player_state_t is the information needed by a player entity
// to do move prediction and to generate a drawable entity
//
export class PlayerStateT {
  messagenum = 0; // all player's won't be updated each frame

  state_time = 0; // not the same as the packet time,
  // because player commands come asyncronously
  command: QwUsercmdT = new QwUsercmdT(); // last command for prediction

  origin: Vec3 = vec3();
  viewangles: Vec3 = vec3(); // only for demos, not from server
  velocity: Vec3 = vec3();
  weaponframe = 0;

  modelindex = 0;
  frame = 0;
  skinnum = 0;
  effects = 0;

  flags = 0; // dead, gib, etc

  waterjumptime = 0;
  onground = 0; // -1 = in air, else pmove entity number
  oldbuttons = 0;

  punchangle = 0; // temporary view kick from weapon firing -- a scalar in QW,
  // not the vec3_t WinQuake's ClientStateT.punchangle is; see file header
}

export class SkinT {
  name = ""; // char name[16]
  failedload = false; // the name isn't a valid skin
  cache: CacheUser<Uint8Array> = new CacheUser<Uint8Array>(); // cache_user_t; the 320*200 skin bitmap Skin_Cache decodes
}

export class PlayerInfoT {
  userid = 0;
  userinfo = ""; // char userinfo[MAX_INFO_STRING]

  // scoreboard information
  name = ""; // char name[MAX_SCOREBOARDNAME]
  entertime = 0;
  frags = 0;
  ping = 0;
  pl = 0; // byte, packet loss

  // skin information
  topcolor = 0;
  bottomcolor = 0;

  _topcolor = 0;
  _bottomcolor = 0;

  spectator = 0;
  translations: Uint8Array = new Uint8Array(VID_GRADES * 256);
  skin: SkinT | null = null; // skin_t *skin
}

export class FrameT {
  // generated on client side
  cmd: QwUsercmdT = new QwUsercmdT(); // cmd that generated the frame
  senttime = 0; // time cmd was sent off
  delta_sequence = 0; // sequence number to delta from, -1 = full update

  // received from server
  receivedtime = 0; // time message was received, or -1
  playerstate: PlayerStateT[] = makeArray(MAX_CLIENTS, () => new PlayerStateT()); // message received
  // that reflects performing the usercmd
  packet_entities: PacketEntitiesT = new PacketEntitiesT();
  invalid = false; // true if the packet_entities delta was invalid
}

export enum DownloadTypeT {
  dl_none = 0,
  dl_model = 1,
  dl_sound = 2,
  dl_skin = 3,
  dl_single = 4,
}

//
// the client_static_t structure is persistant through an arbitrary number
// of server connections -- QW-only additions
//
export class QwClientStaticExtT {
  // network stuff
  netchan: NetchanT = new NetchanT(); // netchan_t (src/qw/net_chan.ts); see file header

  // private userinfo for sending to masterless servers
  userinfo = ""; // char userinfo[MAX_INFO_STRING]

  servername = ""; // char servername[MAX_OSPATH]; name of server from original connect

  qport = 0;

  download: FileHandle | null = null; // FILE *download; file transfer from server
  downloadtempname = ""; // char downloadtempname[MAX_OSPATH]
  downloadname = ""; // char downloadname[MAX_OSPATH]
  downloadnumber = 0;
  downloadtype: DownloadTypeT = DownloadTypeT.dl_none;
  downloadpercent = 0;

  challenge = 0;

  latency = 0; // rolling average
}

//
// the client_state_t structure is wiped completely at every
// server signon -- QW-only additions
//
export class QwClientStateExtT {
  servercount = 0; // server identification for prespawns

  serverinfo = ""; // char serverinfo[MAX_SERVERINFO_STRING]

  parsecount = 0; // server message counter
  validsequence = 0; // this is the sequence number of the last good
  // packetentity_t we got.  If this is 0, we can't
  // render a frame yet

  spectator = 0;

  last_ping_request = 0; // while showing scoreboard
  last_servermessage = 0;

  // sentcmds[cl.netchan.outgoing_sequence & UPDATE_MASK] = cmd
  frames: FrameT[] = makeArray(UPDATE_BACKUP, () => new FrameT());

  // the client simulates or interpolates movement to get these values
  simorg: Vec3 = vec3();
  simvel: Vec3 = vec3();
  simangles: Vec3 = vec3();

  //
  // information that is static for the entire time connected to a server
  //
  model_name: string[] = new Array<string>(MAX_MODELS).fill(""); // char model_name[MAX_MODELS][MAX_QPATH]
  sound_name: string[] = new Array<string>(MAX_SOUNDS).fill(""); // char sound_name[MAX_SOUNDS][MAX_QPATH]

  playernum = 0;

  // all player information
  players: PlayerInfoT[] = makeArray(MAX_CLIENTS, () => new PlayerInfoT());

  // `float punchangle;` -- QW/client/client.h line 262, "temporar yview kick
  // from weapon firing" (sic). WinQuake's ClientStateT.punchangle is a
  // vec3_t, a different quantity with the same name, so QW's scalar lives
  // here rather than colliding with it. svc_smallkick/svc_bigkick
  // (cl_parse.ts) write it; QW's view.c reads it.
  punchangle = 0;

  // `memset (&cl, 0, sizeof(cl))` in QW/client/cl_main.c's CL_ClearState wipes
  // the whole client_state_t, this extension object's fields included;
  // ClientStateT.clear() (src/client/client.ts) deliberately leaves `qw`
  // alone, so this is the other half of that memset.
  clear(): void {
    this.servercount = 0;
    this.serverinfo = "";
    this.parsecount = 0;
    this.validsequence = 0;
    this.spectator = 0;
    this.last_ping_request = 0;
    this.last_servermessage = 0;
    for (const f of this.frames) {
      f.cmd = new QwUsercmdT();
      f.senttime = 0;
      f.delta_sequence = 0;
      f.receivedtime = 0;
      for (let i = 0; i < f.playerstate.length; i++) f.playerstate[i] = new PlayerStateT();
      f.packet_entities = new PacketEntitiesT();
      f.invalid = false;
    }
    this.simorg[0] = this.simorg[1] = this.simorg[2] = 0;
    this.simvel[0] = this.simvel[1] = this.simvel[2] = 0;
    this.simangles[0] = this.simangles[1] = this.simangles[2] = 0;
    this.model_name.fill("");
    this.sound_name.fill("");
    this.playernum = 0;
    this.punchangle = 0;
    for (let i = 0; i < this.players.length; i++) this.players[i] = new PlayerInfoT();
  }
}

function makeArray<T>(n: number, make: () => T): T[] {
  const a: T[] = new Array<T>(n);
  for (let i = 0; i < n; i++) a[i] = make();
  return a;
}

// QW/client/client.h's net-timing ring, filled by CL_CalcNet (cl_parse.ts) and
// read by the net graph (r_misc.c / gl_ngraph.c) and cl_input.c.
export const NET_TIMINGS = 256;
export const NET_TIMINGSMASK = 255;

// entity_state_t cl_baselines[MAX_EDICTS]; -- QW/client/client.h's extern,
// defined in cl_main.c. QW's entity_state_t is src/qw/protocol.ts's
// QwEntityStateT, not the WinQuake one src/client/client.ts's arrays use, so
// this array lives here rather than alongside cl_efrags/cl_static_entities.
export const cl_baselines: QwEntityStateT[] = makeArray(MAX_EDICTS, () => new QwEntityStateT());

// #define CAM_NONE 0 / #define CAM_TRACK 1 (QW/client/client.h). Appended
// here (not previously ported) because src/qw/client/cl_cam.ts already
// imports both from this module and src/qw/client/sbar.ts (Sbar_Draw's
// spectator-camera branch) needs CAM_TRACK too.
export const CAM_NONE = 0;
export const CAM_TRACK = 1;

// pcx_t (QW/client/client.h, under the skin.c section). PORTING.md's rule for
// on-disk binary formats: a DataView read at the C's own offsets. `data` is
// the first byte of the RLE stream, at PCX_DATA_OFS.
export const PCX_DATA_OFS = 128;

export class PcxT {
  manufacturer = 0;
  version = 0;
  encoding = 0;
  bits_per_pixel = 0;
  xmin = 0;
  ymin = 0;
  xmax = 0;
  ymax = 0;
  hres = 0;
  vres = 0;
  palette: Uint8Array = new Uint8Array(48);
  reserved = 0;
  color_planes = 0;
  bytes_per_line = 0;
  palette_type = 0;
}

export function readPcx(buf: Uint8Array): PcxT {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const pcx = new PcxT();
  pcx.manufacturer = view.getInt8(0);
  pcx.version = view.getInt8(1);
  pcx.encoding = view.getInt8(2);
  pcx.bits_per_pixel = view.getInt8(3);
  pcx.xmin = view.getUint16(4, true);
  pcx.ymin = view.getUint16(6, true);
  pcx.xmax = view.getUint16(8, true);
  pcx.ymax = view.getUint16(10, true);
  pcx.hres = view.getUint16(12, true);
  pcx.vres = view.getUint16(14, true);
  pcx.palette.set(buf.subarray(16, 64));
  pcx.reserved = view.getInt8(64);
  pcx.color_planes = view.getInt8(65);
  pcx.bytes_per_line = view.getUint16(66, true);
  pcx.palette_type = view.getUint16(68, true);
  return pcx;
}
