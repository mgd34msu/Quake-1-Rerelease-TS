/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/client.h (GNU GPL v2 or later).

client.h -- the client's shared types, constants and singletons.

Deviations from PORTING.md / the C source:
- `client_state_t` -> `ClientStateT`, `client_static_t` -> `ClientStaticT`, and
  the small structs likewise, per the "C structs -> class" rule. `cl` and `cls`
  are the exported singletons. CL_ClearState's `memset (&cl, 0, sizeof(cl))`
  is `cl.clear()`; `cls` is never memset wholesale in the C, so ClientStaticT
  has no `clear()`.
- `usercmd_t` is declared here in the C, but src/server/server.ts landed first
  and needs it for `client_t.cmd`, so it lives there and is re-exported here.
  Same struct, same field names; nothing declares a second copy.
- `struct sfx_s *sound_precache[MAX_SOUNDS]`: `sfx_t` is sound.h's and
  src/client/snd_dma.ts (U054) has not landed. `SfxT` is `unknown` here, the
  same forward-declaration idiom src/common/model.ts already uses for
  `RendererModelData`/`GlpolyT`. Follow-up: when snd_dma.ts lands it should
  export the real `SfxT` and this alias should become a re-export of it.
- `FILE *demofile`: this port has no FILE*. src/common/common.ts's `FileHandle`
  ({ fd, pos }) is the stand-in COM_FOpenFile already hands back, so
  `cls.demofile` is `FileHandle | null`. cl_demo.ts (U044) records through the
  same handle with Sys_FileWrite.
- `cl_efrags`, `cl_entities`, `cl_static_entities`, `cl_lightstyle`,
  `cl_dlights`, `cl_temp_entities`, `cl_beams`, `cl_visedicts` are `extern` in
  client.h and defined in cl_main.c. They are DEFINED here instead, per
  PORTING.md's "Header modules (quakedef.ts, server.ts, client.ts, progs.ts,
  r_local.ts, glquake.ts) hold shared types, constants, and singletons": every
  one of them is read by modules other than cl_main.c (cl_parse.c, cl_tent.c,
  view.c, r_efrag.c, r_light.c, gl_rmain.c ...), and putting them in cl_main.ts
  would make every renderer file import the client's main module.
- `int cl_numvisedicts` is reassigned from both the client (cl_main.c's
  R_RenderView setup) and the renderers, so per PORTING.md it becomes a field
  on the `clState` holder rather than a reassignable `export let`, which an ESM
  import cannot write through the way C's `extern int` can.
- Not ported here, with the module that owns each:
  * cvars: cl_name, cl_color, cl_upspeed, cl_forwardspeed, cl_backspeed,
    cl_sidespeed, cl_movespeedkey, cl_yawspeed, cl_pitchspeed,
    cl_anglespeedkey, cl_autofire, cl_shownet, cl_nolerp -> cl_main.c's are
    cl_shownet/cl_nolerp/cl_name/cl_color (src/client/cl_main.ts, U041); the
    movement ones plus lookspring, lookstrafe, sensitivity, m_pitch, m_yaw,
    m_forward, m_side, cl_anglespeedkey and cl_autofire are cl_input.c's
    (src/client/cl_input.ts, U043); cl_pitchdriftspeed is view.c's
    (src/client/view.ts, U045).
  * `kbutton_t in_mlook, in_klook, in_strafe, in_speed` are cl_input.c data:
    src/client/cl_input.ts (U043) defines them. Only the type is here.
  * CL_* prototypes -> cl_main.ts (U041), cl_input.ts (U043), cl_demo.ts
    (U044), cl_parse.ts (U042), cl_tent.ts (U046); V_* -> view.ts (U045);
    Key_KeynumToString -> keys.ts (U048).
- Dropped `#ifdef QUAKE2` blocks: usercmd_t's `byte lightlevel`, dlight_t's
  `qboolean dark`, and client_state_t's `int light_level`.
- QuakeWorld track (Q001, PORTING.md's "Client state is a superset" ruling):
  `ClientStaticT`/`ClientStateT` each gain one additive `qw` member
  (`QwClientStaticExtT`/`QwClientStateExtT`, src/qw/client/client.ts, a value
  import -- acyclic, since that module imports nothing from this one) holding
  the QW-only fields of `client_static_t`/`client_state_t`. `CactiveT` gains
  QW's `ca_demostart`/`ca_onserver`/`ca_active`, appended after `ca_connected`;
  see the enum's own comment for why the numbering cannot match the C's QW
  `cactive_t` order.
*/

import type { FileHandle } from "../common/common";
import type { ModelT } from "../common/model";
import type { QsocketT } from "../common/net";
import { MAX_CL_STATS, MAX_EDICTS, MAX_LIGHTSTYLES, MAX_MODELS, MAX_SOUNDS } from "../common/quakedef";
import { type Vec3, vec3 } from "../common/mathlib";
import { SizeBuf } from "../common/sizebuf";
import { UsercmdT } from "../server/server";
import { EntityT, EfragT } from "./render";
import { VID_GRADES } from "./vid";
import { QwClientStateExtT, QwClientStaticExtT } from "../qw/client/client";

export { UsercmdT };

// sound.h's `sfx_t`, narrowed by src/client/snd_dma.ts (U054)
import type { SfxT } from "./sound";
export type { SfxT };

export class LightstyleT {
  length = 0;
  map = ""; // char map[MAX_STYLESTRING]
}

export class ScoreboardT {
  name = ""; // char name[MAX_SCOREBOARDNAME]
  entertime = 0;
  frags = 0;
  colors = 0; // two 4 bit fields
  translations: Uint8Array = new Uint8Array(VID_GRADES * 256);
}

export class CshiftT {
  destcolor: Int32Array = new Int32Array(3);
  percent = 0; // 0-256

  clear(): void {
    this.destcolor[0] = this.destcolor[1] = this.destcolor[2] = 0;
    this.percent = 0;
  }
}

export const CSHIFT_CONTENTS = 0;
export const CSHIFT_DAMAGE = 1;
export const CSHIFT_BONUS = 2;
export const CSHIFT_POWERUP = 3;
export const NUM_CSHIFTS = 4;

export const NAME_LENGTH = 64;

//
// client_state_t should hold all pieces of the client state
//

export const SIGNONS = 4; // signon messages to receive before connected

export const MAX_DLIGHTS = 32;

export class DlightT {
  origin: Vec3 = vec3();
  radius = 0;
  die = 0; // stop lighting after this time
  decay = 0; // drop this each second
  minlight = 0; // don't add when contributing less
  key = 0;
  // QW/client/client.h's dlight_t adds `float color[4]`, which QW's
  // CL_NewDlight/CL_MuzzleFlash/CL_ParseTEnt fill per light type and
  // gl_rlight.c's R_RenderDlight reads. Inert on the WinQuake path (nothing
  // outside src/qw writes it, and WinQuake's R_RenderDlight never reads it).
  color: Float32Array = new Float32Array(4);
}

export const MAX_BEAMS = 24;

export class BeamT {
  entity = 0;
  model: ModelT | null = null;
  endtime = 0;
  start: Vec3 = vec3();
  end: Vec3 = vec3();
}

export const MAX_EFRAGS = 640;

export const MAX_MAPSTRING = 2048;
export const MAX_DEMOS = 8;
export const MAX_DEMONAME = 16;

// QuakeWorld (QW/client/client.h) appends ca_demostart/ca_onserver/ca_active,
// continuing this enum's own numbering (3, 4, 5). The C's QW cactive_t is its
// own enum with a different member order (ca_disconnected, ca_demostart,
// ca_connected, ca_onserver, ca_active = 0-4) that a single shared enum with
// WinQuake's ca_dedicated/ca_disconnected/ca_connected (0-2) cannot reproduce
// numerically for both trees at once -- cactive_t is never sent over the
// wire, so nothing depends on the number, but QW code must compare `cls.state`
// against the named CactiveT members below, never against a literal int.
export enum CactiveT {
  ca_dedicated = 0, // a dedicated server with no ability to start a client
  ca_disconnected = 1, // full screen console with no connection
  ca_connected = 2, // valid netcon, talking to a server
  ca_demostart = 3, // QW: starting up a demo
  ca_onserver = 4, // QW: processing data lists, downloading, etc
  ca_active = 5, // QW: everything is in, so frames can be rendered
}

//
// the client_static_t structure is persistant through an arbitrary number
// of server connections
//
export class ClientStaticT {
  state: CactiveT = CactiveT.ca_dedicated;

  // personalization data sent to server
  mapstring = ""; // char mapstring[MAX_QPATH]
  spawnparms = ""; // to restart a level; char spawnparms[MAX_MAPSTRING]

  // demo loop control
  demonum = 0; // -1 = don't play demos
  demos: string[] = new Array<string>(MAX_DEMOS).fill(""); // when not playing

  // demo recording info must be here, because record is started before
  // entering a map (and clearing client_state_t)
  demorecording = false;
  demoplayback = false;
  timedemo = false;
  forcetrack = 0; // -1 = use normal cd track
  demofile: FileHandle | null = null;
  td_lastframe = 0; // to meter out one message a frame
  td_startframe = 0; // host_framecount at start
  td_starttime = 0; // realtime at second frame of timedemo

  // connection information
  signon = 0; // 0 to SIGNONS
  netcon: QsocketT | null = null;
  message: SizeBuf = new SizeBuf(); // writing buffer to send to server

  // QuakeWorld-only members of client_static_t (QW/client/client.h); see
  // src/qw/client/client.ts's file header.
  qw: QwClientStaticExtT = new QwClientStaticExtT();
}

export const cls = new ClientStaticT();

//
// the client_state_t structure is wiped completely at every
// server signon
//
export class ClientStateT {
  movemessages = 0; // since connecting to this server
  // throw out the first couple, so the player
  // doesn't accidentally do something the
  // first frame
  cmd: UsercmdT = new UsercmdT(); // last command sent to the server

  // information for local display
  stats: Int32Array = new Int32Array(MAX_CL_STATS); // health, etc
  items = 0; // inventory bit flags
  item_gettime: Float32Array = new Float32Array(32); // cl.time of aquiring item, for blinking
  faceanimtime = 0; // use anim frame if cl.time < this

  cshifts: CshiftT[] = makeArray(NUM_CSHIFTS, () => new CshiftT()); // color shifts for damage, powerups
  prev_cshifts: CshiftT[] = makeArray(NUM_CSHIFTS, () => new CshiftT()); // and content types

  // the client maintains its own idea of view angles, which are
  // sent to the server each frame.  The server sets punchangle when
  // the view is temporarliy offset, and an angle reset commands at the start
  // of each level and after teleporting.
  mviewangles: [Vec3, Vec3] = [vec3(), vec3()]; // during demo playback viewangles is lerped
  // between these
  viewangles: Vec3 = vec3();

  mvelocity: [Vec3, Vec3] = [vec3(), vec3()]; // update by server, used for lean+bob
  // (0 is newest)
  velocity: Vec3 = vec3(); // lerped between mvelocity[0] and [1]

  punchangle: Vec3 = vec3(); // temporary offset

  // pitch drifting vars
  idealpitch = 0;
  pitchvel = 0;
  nodrift = false;
  driftmove = 0;
  laststop = 0;

  viewheight = 0;
  crouch = 0; // local amount for smoothing stepups

  paused = false; // send over by server
  onground = false;
  inwater = false;

  intermission = 0; // don't change view angle, full screen, etc
  completed_time = 0; // latched at intermission start

  mtime: Float64Array = new Float64Array(2); // the timestamp of last two messages
  time = 0; // clients view of time, should be between
  // servertime and oldservertime to generate
  // a lerp point for other data
  oldtime = 0; // previous cl.time, time-oldtime is used
  // to decay light values and smooth step ups

  last_received_message = 0; // (realtime) for net trouble icon

  //
  // information that is static for the entire time connected to a server
  //
  model_precache: Array<ModelT | null> = new Array<ModelT | null>(MAX_MODELS).fill(null);
  sound_precache: Array<SfxT | null> = new Array<SfxT | null>(MAX_SOUNDS).fill(null);

  levelname = ""; // for display on solo scoreboard; char levelname[40]
  viewentity = 0; // cl_entitites[cl.viewentity] = player
  maxclients = 0;
  gametype = 0;

  // refresh related state
  worldmodel: ModelT | null = null; // cl_entitites[0].model
  free_efrags: EfragT | null = null;
  num_entities = 0; // held in cl_entities array
  num_statics = 0; // held in cl_staticentities array
  viewent: EntityT = new EntityT(); // the gun model

  cdtrack = 0; // cd audio
  looptrack = 0;

  // frag scoreboard
  scores: ScoreboardT[] = []; // [cl.maxclients]

  // QuakeWorld-only members of client_state_t (QW/client/client.h); see
  // src/qw/client/client.ts's file header. Not reset by clear() below: the
  // SCOPE ruling for this file is additive-only (field + import), so
  // resetting it is QW's own CL_ClearState (src/qw/client/cl_main.ts, not yet
  // landed) to do, mirroring how the same C function clears client_state_t
  // including QW's additions in the C's single struct.
  qw: QwClientStateExtT = new QwClientStateExtT();

  clear(): void {
    this.movemessages = 0;
    this.cmd.viewangles[0] = this.cmd.viewangles[1] = this.cmd.viewangles[2] = 0;
    this.cmd.forwardmove = 0;
    this.cmd.sidemove = 0;
    this.cmd.upmove = 0;
    this.stats.fill(0);
    this.items = 0;
    this.item_gettime.fill(0);
    this.faceanimtime = 0;
    for (const cs of this.cshifts) cs.clear();
    for (const cs of this.prev_cshifts) cs.clear();
    this.mviewangles[0][0] = this.mviewangles[0][1] = this.mviewangles[0][2] = 0;
    this.mviewangles[1][0] = this.mviewangles[1][1] = this.mviewangles[1][2] = 0;
    this.viewangles[0] = this.viewangles[1] = this.viewangles[2] = 0;
    this.mvelocity[0][0] = this.mvelocity[0][1] = this.mvelocity[0][2] = 0;
    this.mvelocity[1][0] = this.mvelocity[1][1] = this.mvelocity[1][2] = 0;
    this.velocity[0] = this.velocity[1] = this.velocity[2] = 0;
    this.punchangle[0] = this.punchangle[1] = this.punchangle[2] = 0;
    this.idealpitch = 0;
    this.pitchvel = 0;
    this.nodrift = false;
    this.driftmove = 0;
    this.laststop = 0;
    this.viewheight = 0;
    this.crouch = 0;
    this.paused = false;
    this.onground = false;
    this.inwater = false;
    this.intermission = 0;
    this.completed_time = 0;
    this.mtime[0] = this.mtime[1] = 0;
    this.time = 0;
    this.oldtime = 0;
    this.last_received_message = 0;
    this.model_precache.fill(null);
    this.sound_precache.fill(null);
    this.levelname = "";
    this.viewentity = 0;
    this.maxclients = 0;
    this.gametype = 0;
    this.worldmodel = null;
    this.free_efrags = null;
    this.num_entities = 0;
    this.num_statics = 0;
    this.viewent.clear();
    this.cdtrack = 0;
    this.looptrack = 0;
    this.scores = [];
  }
}

export const MAX_TEMP_ENTITIES = 64; // lightning bolts, etc
export const MAX_STATIC_ENTITIES = 128; // torches, etc

export const cl = new ClientStateT();

function makeArray<T>(n: number, make: () => T): T[] {
  const a: T[] = new Array<T>(n);
  for (let i = 0; i < n; i++) a[i] = make();
  return a;
}

// FIXME, allocate dynamically
export const cl_efrags: EfragT[] = makeArray(MAX_EFRAGS, () => new EfragT());
export const cl_entities: EntityT[] = makeArray(MAX_EDICTS, () => new EntityT());
export const cl_static_entities: EntityT[] = makeArray(MAX_STATIC_ENTITIES, () => new EntityT());
export const cl_lightstyle: LightstyleT[] = makeArray(MAX_LIGHTSTYLES, () => new LightstyleT());
export const cl_dlights: DlightT[] = makeArray(MAX_DLIGHTS, () => new DlightT());
export const cl_temp_entities: EntityT[] = makeArray(MAX_TEMP_ENTITIES, () => new EntityT());
export const cl_beams: BeamT[] = makeArray(MAX_BEAMS, () => new BeamT());

//=============================================================================

export const MAX_VISEDICTS = 256;
export const cl_visedicts: Array<EntityT | null> = new Array<EntityT | null>(MAX_VISEDICTS).fill(null);

export const clState: { cl_numvisedicts: number } = { cl_numvisedicts: 0 };

//
// cl_input
//
export class KbuttonT {
  down: Int32Array = new Int32Array(2); // key nums holding it down
  state = 0; // low bit is down state
}
