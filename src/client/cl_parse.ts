/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/cl_parse.c (GNU GPL v2 or later).

cl_parse.c -- parse a message received from the server

Deviations from PORTING.md / the C source:
- `CL_KeepaliveMessage`'s C locals `sizebuf_t old` / `byte olddata[8192]` are a
  value-copy snapshot of the whole `net_message` struct plus its current
  bytes, restored after the keepalive read loop. `net_message` here is the
  exported singleton `SizeBuf` from sizebuf.ts (PORTING.md's shared-mutable-
  globals rule: it is never reassigned, only mutated in place), so a plain
  `net_message = old` is not expressible; this port snapshots every field
  into a local object and the byte contents into a local `Uint8Array`, then
  restores each field and the bytes by hand, which is the same observable
  effect as the C's whole-struct copy.
- `CL_ParseServerInfo`'s `cl.scores = Hunk_AllocName (cl.maxclients*sizeof(*cl.scores),
  "scores")` becomes `Array.from({ length: cl.maxclients }, () => new ScoreboardT())`,
  the same convention host.ts's `Host_FindMaxClients` already uses for
  `svs.clients = Hunk_AllocName (svs.maxclientslimit*sizeof(client_t), "clients")`.
- `CL_ParseServerInfo`'s two-line color-separator `Con_Printf` call is a
  string of octal escapes in the C
  (`"\n\n\35\36\36...(35 times)...\36\37\n\n"`); it is written here as
  `"\x1d" + "\x1e".repeat(35) + "\x1f"`, verified byte-for-byte against the C
  source (one 0x1D, thirty-five 0x1E, one 0x1F) rather than retyped by eye.
- `CL_ParseUpdate`'s `#ifdef GLQUAKE` / `#else` split around `U_SKIN` and the
  two `R_TranslatePlayerSkin` call sites is merged into one path that always
  calls `getRenderer().R_TranslatePlayerSkin`, per PORTING.md's renderer-seam
  rule (render.ts's `Renderer` interface has one `R_TranslatePlayerSkin`
  method; the software renderer's implementation is empty, matching the
  C's `#else` branch never calling it). Likewise `CL_NewTranslation`'s
  `#ifdef GLQUAKE R_TranslatePlayerSkin (slot)` runs unconditionally.
- `CL_NewTranslation` dereferences `vid.colormap` (a `Uint8Array | null`
  here, an always-valid `byte *` in the C); a `Sys_Error` guard is added
  before the read for type safety, the same pattern host.ts's
  `SV_ClientPrintf`/`SV_DropClient` use for `svState.host_client`.
- `svc_setpause`'s `#ifdef _WIN32 VID_HandlePause (...)` calls are dropped
  per PORTING.md's non-`_WIN32` path rule.
- `rand()` has no port-wide helper yet (mathlib.ts owns no `rand`/`random`;
  see cl_main.ts's/cl_tent.ts's own file headers, which rule each call site
  implements its own equivalent locally). `CL_ParseUpdate`'s one `rand()&0x7fff`
  syncbase randomization uses a local `rand()` matching cl_tent.ts's.
- No `#if 0` or `#ifdef QUAKE2` blocks appear in this file, so nothing is
  dropped on that account.
*/

import { Cbuf_AddText, Cmd_ExecuteString, CmdSourceT } from "../common/cmd";
import { standard_quake } from "../common/common";
import { Host_EndGame, Host_Error } from "../common/host";
import { setNoclipAnglehack } from "../common/host_cmd";
import { VectorCopy, vec3 } from "../common/mathlib";
import { Mod_ForName, Mod_TouchModel } from "../common/model";
import { SynctypeT } from "../common/modelgen";
import { NET_SendMessage } from "../common/net_main";
import {
  DEFAULT_SOUND_PACKET_ATTENUATION,
  DEFAULT_SOUND_PACKET_VOLUME,
  DEFAULT_VIEWHEIGHT,
  PRFL_SUPPORTED,
  PROTOCOL_FITZQUAKE,
  PROTOCOL_NETQUAKE,
  PROTOCOL_RMQ,
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
  ClcOpsT,
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
  U_SKIN,
  SND_LARGESOUND,
  PROMPT_BEGIN,
  PROMPT_CHOICE,
  PROMPT_CLEAR,
  svc_achievement,
  svc_backtolobby,
  svc_bf,
  svc_botchat,
  svc_chat,
  svc_fog,
  svc_levelcompleted,
  svc_localsound,
  svc_prompt,
  svc_rawprint,
  svc_seq,
  svc_servervars,
  svc_setviews,
  svc_skybox,
  svc_spawnbaseline2,
  svc_spawnedmonster,
  svc_spawnstatic2,
  svc_spawnstaticsound2,
  svc_updateping,
  svc_updateplinfo,
  svc_updatesocial,
} from "../common/protocol";
import { getCodec, protocolSupported } from "../common/protocol/registry";
import { ClientdataTailT, EntityUpdateTailT, SoundHeaderT } from "../common/protocol/codec";
import {
  MSG_BeginReading,
  MSG_ReadByte,
  MSG_ReadChar,
  MSG_ReadFloat,
  MSG_ReadLong,
  MSG_ReadShort,
  MSG_ReadString,
  MSG_WriteByte,
  SZ_Clear,
  msgState,
  net_message,
} from "../common/sizebuf";
import {
  MAX_CL_STATS,
  MAX_EDICTS,
  MAX_LIGHTSTYLES,
  MAX_MODELS,
  MAX_SOUNDS,
  MAX_SCOREBOARD,
  STAT_ACTIVEWEAPON,
  STAT_AMMO,
  STAT_ARMOR,
  STAT_CELLS,
  STAT_HEALTH,
  STAT_NAILS,
  STAT_ROCKETS,
  STAT_MONSTERS,
  STAT_SECRETS,
  STAT_SHELLS,
  STAT_TOTALMONSTERS,
  STAT_WEAPON,
  STAT_WEAPONFRAME,
} from "../common/quakedef";
import { Hunk_Check } from "../common/zone";
import { Sys_Error, Sys_FloatTime } from "../platform/sys";
import { sv } from "../server/server";
import { cdAudio } from "./cdaudio";
import { CL_ClearState, CL_SignonReply, cl_shownet } from "./cl_main";
import { CL_GetMessage } from "./cl_demo";
import { CL_ParseTEnt } from "./cl_tent";
import { Con_DPrintf, Con_Printf } from "./console";
import { PromptChoiceT, SIGNONS, ScoreboardT, cl, cl_entities, cl_lightstyle, cl_static_entities, cls, growEntities, growStaticEntities } from "./client";
import { BOTTOM_RANGE, EntityT, LERP_FINISH, LERP_MOVESTEP, LERP_RESETANIM, LERP_RESETMOVE, TOP_RANGE, getRenderer } from "./render";
import { SS_IsPrimary } from "./splitscreen";
// r_part.c (concurrent sibling, not yet landed -- absent-at-gate rule)
import { R_ParseParticleEffect } from "./r_part";
// sbar.c (concurrent sibling, not yet landed -- absent-at-gate rule)
import { Sbar_Changed } from "./sbar";
// snd_dma.c (concurrent sibling, not yet landed -- absent-at-gate rule)
import { S_BeginPrecaching, S_EndPrecaching, S_LocalSound, S_PrecacheSound, S_StartSound, S_StaticSound, S_StopSound, S_TouchSound } from "./snd_dma";
// screen.c (concurrent sibling, not yet landed -- absent-at-gate rule)
import { SCR_CenterPrint } from "./screen";
// view.c (concurrent sibling, not yet landed -- absent-at-gate rule)
import { V_ParseDamage } from "./view";
import { VID_GRADES, vid } from "./vid";
import { clientProfile } from "../common/profile";
import type * as QwClParseModule from "../qw/client/cl_parse";

/*
==================
CL_ParseLocalSound

U9, "for 2021 rerelease" -- Ironwail Quake/cl_parse.c:200-213 verbatim: a flags
byte carrying SND_LARGESOUND when the sound number needs a short, then the
number. The sound is played without a position, so it is at full volume
wherever the listener is.
==================
*/
export function CL_ParseLocalSound(): void {
  const field_mask = MSG_ReadByte();
  const sound_num = field_mask & SND_LARGESOUND ? MSG_ReadShort() : MSG_ReadByte();
  if (sound_num >= MAX_SOUNDS) Host_Error("CL_ParseLocalSound: %i > MAX_SOUNDS", sound_num);

  const sfx = cl.sound_precache[sound_num];
  if (sfx !== null) S_LocalSound(sfx.name);
}

/*
==================
CL_ParsePrompt

U9. svc_prompt carries one of quakec_ctf's three prompt builtins per message
(PROMPT_BEGIN / PROMPT_CHOICE / PROMPT_CLEAR -- see src/common/protocol.ts),
in the order the QuakeC called them: one `prompt(client, text, numChoices)`
then one `promptchoice(client, text, impulse)` per line. The overlay itself is
src/client/screen.ts's SCR_DrawPrompt, and src/client/keys.ts turns the digit
keys into the chosen impulse.
==================
*/
export function CL_ParsePrompt(): void {
  const op = MSG_ReadByte();

  if (op === PROMPT_BEGIN) {
    cl.promptText = MSG_ReadString();
    cl.promptWanted = MSG_ReadByte();
    cl.promptChoices = [];
    return;
  }

  if (op === PROMPT_CHOICE) {
    const text = MSG_ReadString();
    const impulse = MSG_ReadByte();
    if (cl.promptText !== "") cl.promptChoices.push(new PromptChoiceT(text, impulse));
    return;
  }

  if (op === PROMPT_CLEAR) {
    cl.promptText = "";
    cl.promptWanted = 0;
    cl.promptChoices = [];
    return;
  }

  Con_DPrintf("CL_ParsePrompt: unknown op %i\n", op);
}

export const svc_strings: string[] = [
  "svc_bad",
  "svc_nop",
  "svc_disconnect",
  "svc_updatestat",
  "svc_version", // [long] server version
  "svc_setview", // [short] entity number
  "svc_sound", // <see code>
  "svc_time", // [float] server time
  "svc_print", // [string] null terminated string
  "svc_stufftext", // [string] stuffed into client's console buffer
  // the string should be \n terminated
  "svc_setangle", // [vec3] set the view angle to this absolute value

  "svc_serverinfo", // [long] version
  // [string] signon string
  // [string]..[0]model cache [string]...[0]sounds cache
  // [string]..[0]item cache
  "svc_lightstyle", // [byte] [string]
  "svc_updatename", // [byte] [string]
  "svc_updatefrags", // [byte] [short]
  "svc_clientdata", // <shortbits + data>
  "svc_stopsound", // <see code>
  "svc_updatecolors", // [byte] [byte]
  "svc_particle", // [vec3] <variable>
  "svc_damage", // [byte] impact [byte] blood [vec3] from

  "svc_spawnstatic",
  "OBSOLETE svc_spawnbinary",
  "svc_spawnbaseline",

  "svc_temp_entity", // <variable>
  "svc_setpause",
  "svc_signonnum",
  "svc_centerprint",
  "svc_killedmonster",
  "svc_foundsecret",
  "svc_spawnstaticsound",
  "svc_intermission",
  "svc_finale", // [string] music [string] text
  "svc_cdtrack", // [byte] track [byte] looptrack
  "svc_sellscreen",
  "svc_cutscene",
];

//=============================================================================

/*
===============
CL_EntityNum

This error checks and tracks the total number of entities
===============
*/
// The codec this connection is speaking. `cl.protocol` is set by
// CL_ParseServerInfo, from the live stream or from a demo's recorded
// serverinfo -- the two are the same bytes, so a demo re-derives its protocol
// exactly as a connect does (Ironwail cl_demo.c:133-146's rule).
function qwClParseMod(): typeof QwClParseModule {
  return require("../qw/client/cl_parse");
}

function clCodec() {
  return getCodec(cl.protocol);
}

export function CL_EntityNum(num: number): EntityT {
  if (num >= cl.num_entities) {
    // U3: cl_entities grows on demand up to MAX_EDICTS instead of being a
    // MAX_EDICTS-long array allocated at module load (see client.ts).
    if (!growEntities(num)) Host_Error("CL_EntityNum: %i is an invalid number", num);
    while (cl.num_entities <= num) {
      cl_entities[cl.num_entities].colormap = vid.colormap;
      // johnfitz -- lerping: a slot handed out for the first time has no
      // previous frame, so neither its animation nor its movement lerps in.
      cl_entities[cl.num_entities].lerpflags |= LERP_RESETMOVE | LERP_RESETANIM;
      cl.num_entities++;
    }
  }

  return cl_entities[num];
}

/*
==================
CL_ParseStartSoundPacket
==================
*/
const soundHeader = new SoundHeaderT();

export function CL_ParseStartSoundPacket(): void {
  const codec = clCodec();
  const pos = vec3();
  let volume: number;
  let attenuation: number;

  const field_mask = MSG_ReadByte();

  if (field_mask & SND_VOLUME) volume = MSG_ReadByte();
  else volume = DEFAULT_SOUND_PACKET_VOLUME;

  if (field_mask & SND_ATTENUATION) attenuation = MSG_ReadByte() / 64.0;
  else attenuation = DEFAULT_SOUND_PACKET_ATTENUATION;

  codec.readSoundHeader(field_mask, soundHeader);
  const ent = soundHeader.ent;
  const channel = soundHeader.channel;
  const sound_num = soundHeader.soundNum;

  if (sound_num >= MAX_SOUNDS) Host_Error("CL_ParseStartSoundPacket: %i > MAX_SOUNDS", sound_num);

  if (ent > MAX_EDICTS) Host_Error("CL_ParseStartSoundPacket: ent = %i", ent);

  for (let i = 0; i < 3; i++) pos[i] = codec.readCoord(cl.protocolflags);

  S_StartSound(ent, channel, cl.sound_precache[sound_num], pos, volume / 255.0, attenuation);
}

/*
==================
CL_KeepaliveMessage

When the client is taking a long time to load stuff, send keepalive messages
so the server doesn't disconnect.
==================
*/
let lastmsg = 0; // static float lastmsg

export function CL_KeepaliveMessage(): void {
  if (sv.active) return; // no need if server is local
  if (cls.demoplayback) return;

  // read messages from server, should just be nops
  // old = net_message; memcpy (olddata, net_message.data, net_message.cursize);
  // -- see the file header: net_message is a singleton, snapshotted by hand.
  const old = {
    data: net_message.data,
    maxsize: net_message.maxsize,
    cursize: net_message.cursize,
    allowoverflow: net_message.allowoverflow,
    overflowed: net_message.overflowed,
  };
  const olddata = new Uint8Array(8192);
  olddata.set(net_message.data.subarray(0, net_message.cursize));

  let ret: number;
  do {
    ret = CL_GetMessage();
    switch (ret) {
      default:
        Host_Error("CL_KeepaliveMessage: CL_GetMessage failed");
      // falls through: Host_Error never returns
      case 0:
        break; // nothing waiting
      case 1:
        Host_Error("CL_KeepaliveMessage: received a message");
        break;
      case 2:
        if (MSG_ReadByte() !== SvcOpsT.svc_nop) Host_Error("CL_KeepaliveMessage: datagram wasn't a nop");
        break;
    }
  } while (ret);

  // net_message = old; memcpy (net_message.data, olddata, net_message.cursize);
  net_message.data = old.data;
  net_message.maxsize = old.maxsize;
  net_message.cursize = old.cursize;
  net_message.allowoverflow = old.allowoverflow;
  net_message.overflowed = old.overflowed;
  net_message.data.set(olddata.subarray(0, net_message.cursize));

  // check time
  const time = Sys_FloatTime();
  if (time - lastmsg < 5) return;
  lastmsg = time;

  // write out a nop
  Con_Printf("--> client to server keepalive\n");

  MSG_WriteByte(cls.message, ClcOpsT.clc_nop);
  NET_SendMessage(cls.netcon, cls.message);
  SZ_Clear(cls.message);
}

/*
==================
CL_ParseServerInfo
==================
*/
export function CL_ParseServerInfo(): void {
  Con_DPrintf("Serverinfo packet received.\n");

  //
  // wipe the client_state_t struct
  //
  CL_ClearState();

  // parse protocol version number
  const version = MSG_ReadLong();
  // johnfitz -- support multiple protocols
  if (!protocolSupported(version)) {
    Con_Printf("Server returned version %i, not %i or %i or %i", version, PROTOCOL_NETQUAKE, PROTOCOL_FITZQUAKE, PROTOCOL_RMQ);
    return;
  }
  cl.protocol = version;

  // mh -- read the protocol flags from the server so we know what protocol
  // features to expect. Only PROTOCOL_RMQ carries them.
  cl.protocolflags = clCodec().readProtocolFlags();
  if (cl.protocol === PROTOCOL_RMQ && (cl.protocolflags & ~PRFL_SUPPORTED) !== 0) {
    Con_Printf("PROTOCOL_RMQ protocolflags %i contains unsupported flags\n", cl.protocolflags);
  }

  // parse maxclients
  cl.maxclients = MSG_ReadByte();
  if (cl.maxclients < 1 || cl.maxclients > MAX_SCOREBOARD) {
    Con_Printf("Bad maxclients (%u) from server\n", cl.maxclients);
    return;
  }
  // Hunk_AllocName (cl.maxclients*sizeof(*cl.scores), "scores")
  cl.scores = Array.from({ length: cl.maxclients }, () => new ScoreboardT());

  // parse gametype
  cl.gametype = MSG_ReadByte();

  // parse signon message
  let str = MSG_ReadString();
  cl.levelname = str.slice(0, 39); // strncpy (cl.levelname, str, sizeof(cl.levelname)-1)

  // seperate the printfs so the server message can have a color
  Con_Printf("\n\n" + "\x1d" + "\x1e".repeat(35) + "\x1f" + "\n\n");
  Con_Printf("%c%s\n", 2, str);

  //
  // first we go through and touch all of the precache data that still
  // happens to be in the cache, so precaching something else doesn't
  // needlessly purge it
  //

  // precache models
  cl.model_precache.fill(null); // memset (cl.model_precache, 0, sizeof(cl.model_precache))
  const model_precache: string[] = new Array<string>(MAX_MODELS).fill("");
  let nummodels = 1;
  for (; ; nummodels++) {
    str = MSG_ReadString();
    if (!str[0]) break;
    if (nummodels === MAX_MODELS) {
      Con_Printf("Server sent too many model precaches\n");
      return;
    }
    model_precache[nummodels] = str;
    Mod_TouchModel(str);
  }

  // precache sounds
  cl.sound_precache.fill(null); // memset (cl.sound_precache, 0, sizeof(cl.sound_precache))
  const sound_precache: string[] = new Array<string>(MAX_SOUNDS).fill("");
  let numsounds = 1;
  for (; ; numsounds++) {
    str = MSG_ReadString();
    if (!str[0]) break;
    if (numsounds === MAX_SOUNDS) {
      Con_Printf("Server sent too many sound precaches\n");
      return;
    }
    sound_precache[numsounds] = str;
    S_TouchSound(str);
  }

  //
  // now we try to load everything else until a cache allocation fails
  //

  for (let i = 1; i < nummodels; i++) {
    cl.model_precache[i] = Mod_ForName(model_precache[i], false);
    if (cl.model_precache[i] === null) {
      Con_Printf("Model %s not found\n", model_precache[i]);
      return;
    }
    CL_KeepaliveMessage();
  }

  S_BeginPrecaching();
  for (let i = 1; i < numsounds; i++) {
    cl.sound_precache[i] = S_PrecacheSound(sound_precache[i]);
    CL_KeepaliveMessage();
  }
  S_EndPrecaching();

  // local state
  cl.worldmodel = cl.model_precache[1];
  cl_entities[0].model = cl.worldmodel;

  // U43: R_NewMap rebuilds the renderer's whole per-map state (lightmaps,
  // the surface cache, the sky). The world is one world however many seats
  // are looking at it, so only the primary client's signon builds it; a seat
  // joining a running level would otherwise throw that work away and rebuild
  // it mid-frame.
  if (SS_IsPrimary()) getRenderer().R_NewMap();

  Hunk_Check(); // make sure nothing is hurt

  setNoclipAnglehack(false); // noclip is turned off at start
}

/*
==================
CL_ParseUpdate

Parse an entity update message from the server
If an entities model or origin changes from frame to frame, it must be
relinked.  Other attributes can change without relinking.
==================
*/
const bitcounts: number[] = new Array<number>(16).fill(0);

// rand() has no port-wide helper -- see file header's ruling
function rand(): number {
  return Math.floor(Math.random() * 0x8000);
}

const entityUpdateTail = new EntityUpdateTailT();

export function CL_ParseUpdate(bitsIn: number): void {
  const codec = clCodec();
  let bits = bitsIn;

  if (cls.signon === SIGNONS_LAST) {
    // first update is the final signon stage
    cls.signon = SIGNONS_TOTAL;
    CL_SignonReply();
  }

  if (bits & U_MOREBITS) {
    const extra = MSG_ReadByte();
    bits |= extra << 8;
  }

  // U_EXTEND1 / U_EXTEND2 on 666 and 999; a no-op on 15
  bits = codec.readEntityBits(bits);

  let num: number;
  if (bits & U_LONGENTITY) num = MSG_ReadShort();
  else num = MSG_ReadByte();

  const ent = CL_EntityNum(num);

  for (let i = 0; i < 16; i++) if (bits & (1 << i)) bitcounts[i]++;

  let forcelink: boolean;
  if (ent.msgtime !== cl.mtime[1]) forcelink = true; // no previous frame to lerp from
  else forcelink = false;

  // johnfitz -- lerping: more than 0.2 seconds since the last message (most
  // entities think every 0.1 sec) -- if we missed a think, we'd be lerping
  // from the wrong frame
  if (ent.msgtime + 0.2 < cl.mtime[0]) ent.lerpflags |= LERP_RESETANIM;

  ent.msgtime = cl.mtime[0];

  let modnum: number;
  if (bits & U_MODEL) {
    modnum = MSG_ReadByte();
    if (modnum >= MAX_MODELS) Host_Error("CL_ParseModel: bad modnum");
  } else modnum = ent.baseline.modelindex;

  let i: number;
  if (bits & U_FRAME) ent.frame = MSG_ReadByte();
  else ent.frame = ent.baseline.frame;

  if (bits & U_COLORMAP) i = MSG_ReadByte();
  else i = ent.baseline.colormap;
  if (!i) ent.colormap = vid.colormap;
  else {
    if (i > cl.maxclients) Sys_Error("i >= cl.maxclients");
    ent.colormap = cl.scores[i - 1].translations;
  }

  let skin: number;
  if (bits & U_SKIN) skin = MSG_ReadByte();
  else skin = ent.baseline.skin;
  if (skin !== ent.skinnum) {
    ent.skinnum = skin;
    if (num > 0 && num <= cl.maxclients) getRenderer().R_TranslatePlayerSkin(num - 1);
  }

  if (bits & U_EFFECTS) ent.effects = MSG_ReadByte();
  else ent.effects = ent.baseline.effects;

  // shift the known values for interpolation
  VectorCopy(ent.msg_origins[0], ent.msg_origins[1]);
  VectorCopy(ent.msg_angles[0], ent.msg_angles[1]);

  if (bits & U_ORIGIN1) ent.msg_origins[0][0] = codec.readCoord(cl.protocolflags);
  else ent.msg_origins[0][0] = ent.baseline.origin[0];
  if (bits & U_ANGLE1) ent.msg_angles[0][0] = codec.readAngle(cl.protocolflags);
  else ent.msg_angles[0][0] = ent.baseline.angles[0];

  if (bits & U_ORIGIN2) ent.msg_origins[0][1] = codec.readCoord(cl.protocolflags);
  else ent.msg_origins[0][1] = ent.baseline.origin[1];
  if (bits & U_ANGLE2) ent.msg_angles[0][1] = codec.readAngle(cl.protocolflags);
  else ent.msg_angles[0][1] = ent.baseline.angles[1];

  if (bits & U_ORIGIN3) ent.msg_origins[0][2] = codec.readCoord(cl.protocolflags);
  else ent.msg_origins[0][2] = ent.baseline.origin[2];
  if (bits & U_ANGLE3) ent.msg_angles[0][2] = codec.readAngle(cl.protocolflags);
  else ent.msg_angles[0][2] = ent.baseline.angles[2];

  // johnfitz -- lerping for movetype_step entities
  if (bits & U_NOLERP) {
    ent.lerpflags |= LERP_MOVESTEP;
    ent.forcelink = true;
  } else {
    ent.lerpflags &= ~LERP_MOVESTEP;
  }

  // johnfitz -- PROTOCOL_FITZQUAKE: alpha, scale, the high bytes of frame and
  // modelindex, and the lerp finish time. Empty on protocol 15, where the
  // codec's tail reader reads nothing and leaves the defaults.
  codec.readEntityUpdateTail(bits, entityUpdateTail);
  ent.alpha = entityUpdateTail.hasAlpha ? entityUpdateTail.alpha : ent.baseline.alpha;
  ent.scale = entityUpdateTail.hasScale ? entityUpdateTail.scale : ent.baseline.scale;
  if (entityUpdateTail.hasFrame2) ent.frame = (ent.frame & 0x00ff) | (entityUpdateTail.frameHigh << 8);
  if (entityUpdateTail.hasModel2) modnum = (modnum & 0x00ff) | (entityUpdateTail.modelHigh << 8);
  if (entityUpdateTail.hasLerpfinish) {
    ent.lerpfinish = ent.msgtime + entityUpdateTail.lerpfinish;
    ent.lerpflags |= LERP_FINISH;
  } else {
    ent.lerpflags &= ~LERP_FINISH;
  }

  // johnfitz -- moved here from above: U_MODEL2 can still change modnum
  const model = cl.model_precache[modnum];
  if (model !== ent.model) {
    ent.model = model;
    // automatic animation (torches, etc) can be either all together
    // or randomized
    if (model) {
      if (model.synctype === SynctypeT.ST_RAND) ent.syncbase = (rand() & 0x7fff) / 0x7fff;
      else ent.syncbase = 0.0;
    } else forcelink = true; // hack to make null model players work

    if (num > 0 && num <= cl.maxclients) getRenderer().R_TranslatePlayerSkin(num - 1);

    ent.lerpflags |= LERP_RESETANIM; // johnfitz -- don't lerp animation across model changes
  }

  if (forcelink) {
    // didn't have an update last message
    VectorCopy(ent.msg_origins[0], ent.msg_origins[1]);
    VectorCopy(ent.msg_origins[0], ent.origin);
    VectorCopy(ent.msg_angles[0], ent.msg_angles[1]);
    VectorCopy(ent.msg_angles[0], ent.angles);
    ent.forcelink = true;
  }
}

// SIGNONS - 1 / SIGNONS, spelled out so CL_ParseUpdate reads like the C's
// `cls.signon == SIGNONS - 1` / `cls.signon = SIGNONS` without importing a
// second name for the same constant.
const SIGNONS_LAST = SIGNONS - 1;
const SIGNONS_TOTAL = SIGNONS;

/*
==================
CL_ParseBaseline
==================
*/
// `version` is 1 for svc_spawnbaseline / svc_spawnstatic and 2 for their
// 666/999 `2` forms, which prefix a B_* flag byte (Ironwail's
// `CL_ParseBaseline (ent, version)`).
export function CL_ParseBaseline(ent: EntityT, version = 1): void {
  clCodec().readBaseline(ent.baseline, version, cl.protocolflags);
}

/*
==================
CL_ParseClientdata

Server information pertaining to this client only
==================
*/
const clientdataTail = new ClientdataTailT();

// johnfitz -- the bit word is read here instead of in CL_ParseServerMessage,
// because 666/999 follow it with up to two more bytes.
export function CL_ParseClientdata(): void {
  const codec = clCodec();
  const bits = codec.readClientdataBits();

  if (bits & SU_VIEWHEIGHT) cl.viewheight = MSG_ReadChar();
  else cl.viewheight = DEFAULT_VIEWHEIGHT;

  if (bits & SU_IDEALPITCH) cl.idealpitch = MSG_ReadChar();
  else cl.idealpitch = 0;

  VectorCopy(cl.mvelocity[0], cl.mvelocity[1]);
  for (let i = 0; i < 3; i++) {
    if (bits & (SU_PUNCH1 << i)) cl.punchangle[i] = MSG_ReadChar();
    else cl.punchangle[i] = 0;
    if (bits & (SU_VELOCITY1 << i)) cl.mvelocity[0][i] = MSG_ReadChar() * 16;
    else cl.mvelocity[0][i] = 0;
  }

  // [always sent]	if (bits & SU_ITEMS)
  let i = MSG_ReadLong();

  if (cl.items !== i) {
    // set flash times
    Sbar_Changed();
    for (let j = 0; j < 32; j++) if (i & (1 << j) && !(cl.items & (1 << j))) cl.item_gettime[j] = cl.time;
    cl.items = i;
  }

  cl.onground = (bits & SU_ONGROUND) !== 0;
  cl.inwater = (bits & SU_INWATER) !== 0;

  if (bits & SU_WEAPONFRAME) cl.stats[STAT_WEAPONFRAME] = MSG_ReadByte();
  else cl.stats[STAT_WEAPONFRAME] = 0;

  if (bits & SU_ARMOR) i = MSG_ReadByte();
  else i = 0;
  if (cl.stats[STAT_ARMOR] !== i) {
    cl.stats[STAT_ARMOR] = i;
    Sbar_Changed();
  }

  if (bits & SU_WEAPON) i = MSG_ReadByte();
  else i = 0;
  if (cl.stats[STAT_WEAPON] !== i) {
    cl.stats[STAT_WEAPON] = i;
    Sbar_Changed();
  }

  i = MSG_ReadShort();
  if (cl.stats[STAT_HEALTH] !== i) {
    cl.stats[STAT_HEALTH] = i;
    Sbar_Changed();
  }

  i = MSG_ReadByte();
  if (cl.stats[STAT_AMMO] !== i) {
    cl.stats[STAT_AMMO] = i;
    Sbar_Changed();
  }

  for (let k = 0; k < 4; k++) {
    const j = MSG_ReadByte();
    if (cl.stats[STAT_SHELLS + k] !== j) {
      cl.stats[STAT_SHELLS + k] = j;
      Sbar_Changed();
    }
  }

  i = MSG_ReadByte();

  if (standard_quake) {
    if (cl.stats[STAT_ACTIVEWEAPON] !== i) {
      cl.stats[STAT_ACTIVEWEAPON] = i;
      Sbar_Changed();
    }
  } else {
    if (cl.stats[STAT_ACTIVEWEAPON] !== (1 << i)) {
      cl.stats[STAT_ACTIVEWEAPON] = 1 << i;
      Sbar_Changed();
    }
  }

  // johnfitz -- PROTOCOL_FITZQUAKE: the high byte of each widened stat, and
  // the weapon model's alpha. All zero on protocol 15.
  codec.readClientdataTail(bits, clientdataTail);
  cl.stats[STAT_WEAPON] |= clientdataTail.weaponHigh << 8;
  cl.stats[STAT_ARMOR] |= clientdataTail.armorHigh << 8;
  cl.stats[STAT_AMMO] |= clientdataTail.ammoHigh << 8;
  cl.stats[STAT_SHELLS] |= clientdataTail.shellsHigh << 8;
  cl.stats[STAT_NAILS] |= clientdataTail.nailsHigh << 8;
  cl.stats[STAT_ROCKETS] |= clientdataTail.rocketsHigh << 8;
  cl.stats[STAT_CELLS] |= clientdataTail.cellsHigh << 8;
  cl.stats[STAT_WEAPONFRAME] |= clientdataTail.weaponframeHigh << 8;
  // U16: was parked in the standalone `clViewentAlpha` (a U3 EntityExtT) --
  // cl.viewent is an EntityT from src/client/render.ts and now carries its
  // own `alpha` field directly (Ironwail's `cl.viewent.alpha`).
  cl.viewent.alpha = clientdataTail.weaponalpha;
}

/*
=====================
CL_NewTranslation
=====================
*/
export function CL_NewTranslation(slot: number): void {
  if (slot > cl.maxclients) Sys_Error("CL_NewTranslation: slot > cl.maxclients");
  const dest = cl.scores[slot].translations;
  const source = vid.colormap;
  if (source === null) Sys_Error("CL_NewTranslation: vid.colormap is not set");
  dest.set(source.subarray(0, dest.length)); // memcpy (dest, vid.colormap, sizeof(cl.scores[slot].translations))
  const top = cl.scores[slot].colors & 0xf0;
  const bottom = (cl.scores[slot].colors & 15) << 4;

  getRenderer().R_TranslatePlayerSkin(slot);

  for (let i = 0, destOff = 0, sourceOff = 0; i < VID_GRADES; i++, destOff += 256, sourceOff += 256) {
    if (top < 128) {
      // the artists made some backwards ranges.  sigh.
      dest.set(source.subarray(sourceOff + top, sourceOff + top + 16), destOff + TOP_RANGE);
    } else {
      for (let j = 0; j < 16; j++) dest[destOff + TOP_RANGE + j] = source[sourceOff + top + 15 - j];
    }

    if (bottom < 128) {
      dest.set(source.subarray(sourceOff + bottom, sourceOff + bottom + 16), destOff + BOTTOM_RANGE);
    } else {
      for (let j = 0; j < 16; j++) dest[destOff + BOTTOM_RANGE + j] = source[sourceOff + bottom + 15 - j];
    }
  }
}

/*
=====================
CL_ParseStatic
=====================
*/
/** Where a non-primary seat's svc_spawnstatic is read to and dropped; see
 *  CL_ParseStatic. */
const staticDiscard = new EntityT();

export function CL_ParseStatic(version = 1): void {
  // U43: static entities are linked into the SHARED worldmodel's leaves by
  // R_AddEfrags, and every splitscreen seat's signon describes the same
  // statics the primary client already linked -- a seat's copy would be a
  // second entity in the same leaf chain, drawn on top of the first in every
  // seat's leaf walk. The message is still read in full (it is part of this
  // seat's signon stream) and then dropped.
  if (!SS_IsPrimary()) {
    CL_ParseBaseline(staticDiscard, version);
    return;
  }

  const i = cl.num_statics;
  if (!growStaticEntities(i)) Host_Error("Too many static entities");
  const ent = cl_static_entities[i];
  cl.num_statics++;
  CL_ParseBaseline(ent, version);

  // copy it to the current state
  ent.model = cl.model_precache[ent.baseline.modelindex];
  ent.frame = ent.baseline.frame;
  ent.colormap = vid.colormap;
  ent.skinnum = ent.baseline.skin;
  ent.effects = ent.baseline.effects;
  ent.alpha = ent.baseline.alpha; // johnfitz -- alpha
  ent.scale = ent.baseline.scale;

  VectorCopy(ent.baseline.origin, ent.origin);
  VectorCopy(ent.baseline.angles, ent.angles);
  getRenderer().R_AddEfrags(ent);
}

/*
===================
CL_ParseStaticSound
===================
*/
export function CL_ParseStaticSound(version = 1): void {
  const codec = clCodec();
  const org = vec3();
  for (let i = 0; i < 3; i++) org[i] = codec.readCoord(cl.protocolflags);
  const sound_num = codec.readStaticSoundIndex(version);
  const vol = MSG_ReadByte();
  const atten = MSG_ReadByte();

  S_StaticSound(cl.sound_precache[sound_num], org, vol, atten);
}

function SHOWNET(x: string): void {
  if (cl_shownet.value === 2) Con_Printf("%3i:%s\n", msgState.readcount - 1, x);
}

/*
=====================
CL_ParseServerMessage
=====================
*/
export function CL_ParseServerMessage(): void {
  let i: number;

  // Unified client (ARCHITECTURE.md "Unified client and server"): the message
  // in net_message belongs to whichever protocol family this connection
  // speaks, so the QuakeWorld profile parses it with QW/client/cl_parse.c's
  // own CL_ParseServerMessage. Reached lazily -- that module imports this one.
  if (clientProfile() === "qw") {
    qwClParseMod().CL_ParseServerMessage();
    return;
  }

  //
  // if recording demos, copy the message out
  //
  if (cl_shownet.value === 1) Con_Printf("%i ", net_message.cursize);
  else if (cl_shownet.value === 2) Con_Printf("------------------\n");

  cl.onground = false; // unless the server says otherwise

  //
  // parse the message
  //
  MSG_BeginReading();

  while (true) {
    if (msgState.badread) Host_Error("CL_ParseServerMessage: Bad server message");

    const cmd = MSG_ReadByte();

    if (cmd === -1) {
      SHOWNET("END OF MESSAGE");
      return; // end of message
    }

    // if the high bit of the command byte is set, it is a fast update
    if (cmd & 128) {
      SHOWNET("fast update");
      CL_ParseUpdate(cmd & 127);
      continue;
    }

    SHOWNET(cmd < svc_strings.length ? svc_strings[cmd] : `svc_${cmd}`);

    // other commands
    switch (cmd) {
      default:
        Host_Error("CL_ParseServerMessage: Illegible server message\n");
        break;

      case SvcOpsT.svc_nop:
        //			Con_Printf ("svc_nop\n");
        break;

      case SvcOpsT.svc_time:
        cl.mtime[1] = cl.mtime[0];
        cl.mtime[0] = MSG_ReadFloat();
        break;

      case SvcOpsT.svc_clientdata:
        CL_ParseClientdata(); // johnfitz -- the bit word is read inside now
        break;

      case SvcOpsT.svc_version:
        i = MSG_ReadLong();
        if (!protocolSupported(i)) Host_Error("CL_ParseServerMessage: Server is protocol %i instead of %i or %i or %i\n", i, PROTOCOL_NETQUAKE, PROTOCOL_FITZQUAKE, PROTOCOL_RMQ);
        cl.protocol = i;
        break;

      case SvcOpsT.svc_disconnect:
        Host_EndGame("Server disconnected\n");
      // falls through: Host_EndGame never returns, matching the C's missing `break`

      case SvcOpsT.svc_print:
        Con_Printf("%s", MSG_ReadString());
        break;

      case SvcOpsT.svc_centerprint:
        SCR_CenterPrint(MSG_ReadString());
        break;

      case SvcOpsT.svc_stufftext:
        Cbuf_AddText(MSG_ReadString());
        break;

      case SvcOpsT.svc_damage:
        V_ParseDamage();
        break;

      case SvcOpsT.svc_serverinfo:
        CL_ParseServerInfo();
        vid.recalc_refdef = 1; // leave intermission full screen
        break;

      case SvcOpsT.svc_setangle:
        // Ironwail cl_parse.c:1183 -- `MSG_ReadAngle (cl.protocolflags)`, so a
        // PRFL_SHORTANGLE session reads a short here, not a byte. Plain
        // MSG_ReadAngle would consume three bytes of a six-byte payload and
        // desync the rest of the message.
        for (i = 0; i < 3; i++) cl.viewangles[i] = clCodec().readAngle(cl.protocolflags);
        break;

      case SvcOpsT.svc_setview:
        cl.viewentity = MSG_ReadShort();
        break;

      case SvcOpsT.svc_lightstyle:
        i = MSG_ReadByte();
        if (i >= MAX_LIGHTSTYLES) Sys_Error("svc_lightstyle > MAX_LIGHTSTYLES");
        cl_lightstyle[i].map = MSG_ReadString(); // Q_strcpy (cl_lightstyle[i].map, ...)
        cl_lightstyle[i].length = cl_lightstyle[i].map.length; // Q_strlen (cl_lightstyle[i].map)
        break;

      case SvcOpsT.svc_sound:
        CL_ParseStartSoundPacket();
        break;

      case SvcOpsT.svc_stopsound:
        i = MSG_ReadShort();
        S_StopSound(i >> 3, i & 7);
        break;

      case SvcOpsT.svc_updatename:
        Sbar_Changed();
        i = MSG_ReadByte();
        if (i >= cl.maxclients) Host_Error("CL_ParseServerMessage: svc_updatename > MAX_SCOREBOARD");
        cl.scores[i].name = MSG_ReadString(); // strcpy (cl.scores[i].name, ...)
        break;

      case SvcOpsT.svc_updatefrags:
        Sbar_Changed();
        i = MSG_ReadByte();
        if (i >= cl.maxclients) Host_Error("CL_ParseServerMessage: svc_updatefrags > MAX_SCOREBOARD");
        cl.scores[i].frags = MSG_ReadShort();
        break;

      case SvcOpsT.svc_updatecolors:
        Sbar_Changed();
        i = MSG_ReadByte();
        if (i >= cl.maxclients) Host_Error("CL_ParseServerMessage: svc_updatecolors > MAX_SCOREBOARD");
        cl.scores[i].colors = MSG_ReadByte();
        CL_NewTranslation(i);
        break;

      case SvcOpsT.svc_particle:
        R_ParseParticleEffect();
        break;

      case SvcOpsT.svc_spawnbaseline:
        i = MSG_ReadShort();
        // must use CL_EntityNum() to force cl.num_entities up
        CL_ParseBaseline(CL_EntityNum(i), 1);
        break;
      case SvcOpsT.svc_spawnstatic:
        CL_ParseStatic(1);
        break;
      case SvcOpsT.svc_temp_entity:
        CL_ParseTEnt();
        break;

      case SvcOpsT.svc_setpause: {
        cl.paused = MSG_ReadByte() !== 0;

        if (cl.paused) {
          cdAudio.current?.CDAudio_Pause();
        } else {
          cdAudio.current?.CDAudio_Resume();
        }
        break;
      }

      case SvcOpsT.svc_signonnum:
        i = MSG_ReadByte();
        if (i <= cls.signon) Host_Error("Received signon %i when at %i", i, cls.signon);
        cls.signon = i;
        CL_SignonReply();
        break;

      case SvcOpsT.svc_killedmonster:
        cl.stats[STAT_MONSTERS]++;
        break;

      case SvcOpsT.svc_foundsecret:
        cl.stats[STAT_SECRETS]++;
        break;

      case SvcOpsT.svc_updatestat:
        i = MSG_ReadByte();
        if (i < 0 || i >= MAX_CL_STATS) Sys_Error("svc_updatestat: %i is invalid", i);
        cl.stats[i] = MSG_ReadLong();
        break;

      case SvcOpsT.svc_spawnstaticsound:
        CL_ParseStaticSound(1);
        break;

      // johnfitz -- PROTOCOL_FITZQUAKE's own opcodes (37, 40-44). They are
      // `export const`s rather than SvcOpsT members: SvcOpsT is protocol 15's
      // set exactly, and `svc_strings` above is indexed by it.
      case svc_spawnbaseline2:
        i = MSG_ReadShort();
        CL_ParseBaseline(CL_EntityNum(i), 2);
        break;
      case svc_spawnstatic2:
        CL_ParseStatic(2);
        break;
      case svc_spawnstaticsound2:
        CL_ParseStaticSound(2);
        break;
      case svc_skybox: {
        // [string] name -- QuakeSpasm's Sky_LoadSkyBox. Loading a skybox is a
        // no-op under ref_soft, so the seam member is optional (render.ts).
        const name = MSG_ReadString();
        getRenderer().skyLoadSkyBox?.(name);
        break;
      }
      case svc_bf:
        // Ironwail runs the `bf` console command (a screen flash); screen.ts's
        // flash is a later unit, so this opcode carries no payload to skip.
        break;
      case svc_fog: {
        // [byte] density [byte] red [byte] green [byte] blue [short] time.
        // The five raw wire values go to the renderer, which owns the /255 and
        // /100 conversions (render.ts's fogParseServerMessage contract).
        const density = MSG_ReadByte();
        const r = MSG_ReadByte();
        const g = MSG_ReadByte();
        const b = MSG_ReadByte();
        const time = MSG_ReadShort();
        getRenderer().fogParseServerMessage?.(density, r, g, b, time);
        break;
      }

      case SvcOpsT.svc_cdtrack:
        cl.cdtrack = MSG_ReadByte();
        cl.looptrack = MSG_ReadByte();
        if ((cls.demoplayback || cls.demorecording) && cls.forcetrack !== -1) cdAudio.current?.CDAudio_Play(cls.forcetrack & 0xff, true);
        else cdAudio.current?.CDAudio_Play(cl.cdtrack & 0xff, true);
        break;

      case SvcOpsT.svc_intermission:
        cl.intermission = 1;
        cl.completed_time = cl.time;
        vid.recalc_refdef = 1; // go to full screen
        break;

      case SvcOpsT.svc_finale:
        cl.intermission = 2;
        cl.completed_time = cl.time;
        vid.recalc_refdef = 1; // go to full screen
        SCR_CenterPrint(MSG_ReadString());
        break;

      case SvcOpsT.svc_cutscene:
        cl.intermission = 3;
        cl.completed_time = cl.time;
        vid.recalc_refdef = 1; // go to full screen
        SCR_CenterPrint(MSG_ReadString());
        break;

      case SvcOpsT.svc_sellscreen:
        Cmd_ExecuteString("help", CmdSourceT.src_command);
        break;

      //========================================================================
      // U9: the 2021 re-release's own opcodes. Only two of these are defined by
      // anything readable: svc_achievement, which the QuakeC writes by hand as
      // `WriteByte(SVC_ACHIEVEMENT); WriteString("ACH_...")`
      // (quakec/client.qc:329) and Ironwail reads at cl_parse.c:1374-1381, and
      // svc_localsound, whose payload is Ironwail's CL_ParseLocalSound
      // (cl_parse.c:200-213). The rest are declared-but-dead in the QuakeC and
      // unhandled in all three reference engines -- which means Ironwail,
      // vkQuake and QuakeSpasm all Host_Error on one. The payloads read here
      // are this engine's own, documented in src/common/protocol.ts; every one
      // of them is consumed so the stream stays in sync, and none of them is an
      // error.
      case svc_achievement: {
        const id = MSG_ReadString();
        Con_DPrintf("achievement %s\n", id);
        break;
      }

      case svc_localsound:
        CL_ParseLocalSound();
        break;

      case svc_chat:
        Con_Printf("%s", MSG_ReadString());
        break;

      case svc_botchat:
        Con_Printf("%s", MSG_ReadString());
        break;

      case svc_rawprint:
        Con_Printf("%s", MSG_ReadString());
        break;

      case svc_levelcompleted:
        cl.levelcompleted = true;
        Con_DPrintf("svc_levelcompleted\n");
        break;

      case svc_backtolobby:
        cl.backtolobby = true;
        Con_DPrintf("svc_backtolobby\n");
        break;

      case svc_spawnedmonster:
        // [byte] monsters added to the level total. STAT_TOTALMONSTERS is what
        // the HUD counts against, and svc_killedmonster already bumps its
        // partner STAT_MONSTERS, so this keeps the two in step.
        {
          const count = MSG_ReadByte();
          cl.spawnedmonsters += count;
          cl.stats[STAT_TOTALMONSTERS] += count;
          Sbar_Changed();
        }
        break;

      case svc_setviews:
        cl.numviews = MSG_ReadByte();
        break;

      case svc_updateping:
        // [byte] client [short] milliseconds. scoreboard_t has no ping field
        // in NetQuake (QuakeWorld's does); read past it so the stream stays in
        // sync, and leave the value to whichever unit adds the field.
        MSG_ReadByte();
        MSG_ReadShort();
        break;

      case svc_updatesocial:
        MSG_ReadByte();
        MSG_ReadString();
        break;

      case svc_updateplinfo:
        MSG_ReadByte();
        MSG_ReadString();
        break;

      case svc_servervars:
        cl.servervars = MSG_ReadString();
        break;

      case svc_seq:
        cl.seq = MSG_ReadLong();
        break;

      case svc_prompt:
        CL_ParsePrompt();
        break;
    }
  }
}
