/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/cl_main.c (GNU GPL v2 or later).

cl_main.c -- client main loop

Deviations from PORTING.md / the C source:
- `cl_name`/`cl_color`: the C's variable names are `cl_name`/`cl_color` but the
  cvar's registered NAME string is `_cl_name`/`_cl_color` (`cvar_t cl_name =
  {"_cl_name", "player", true};` -- "these two are not intended to be set
  directly", per the C's own comment). The leading underscore is part of the
  cvar name and is kept exactly.
- `SetPal` is entirely `#if 0` in the C (a dead debugging tool that flashes
  the screen); per PORTING.md's dead-`#if 0` rule it, and its three call
  sites inside CL_LerpPoint (`SetPal(1)`/`SetPal(2)`/`SetPal(0)`), are dropped
  rather than ported as a no-op function.
- `dlight_t`/`efrag_t`/`lightstyle_t`/`beam_t` (client.ts, render.ts) have no
  `clear()` method -- only the structs those two units' own C files memset
  wholesale got one. CL_ClearState and CL_AllocDlight memset every one of
  these individually in the C (`memset (dl, 0, sizeof(*dl))`,
  `memset (cl_efrags, 0, sizeof(cl_efrags))`, ...), so this file has its own
  small `clearDlight`/`clearEfrag`/`clearLightstyle`/`clearBeam` helpers that
  zero every field by hand, mirroring the C's memset at each call site.
- `rand()` has no port-wide helper (mathlib.ts owns no `rand`/`random`; see
  src/progs/pr_cmds.ts's file header, which rules each call site implements
  its own `rand()`-equivalent locally). CL_RelinkEntities's three `rand()&31`
  dlight-radius randomizations use a local `rand31()`.
- `SCR_BeginLoadingPlaque`/`SCR_EndLoadingPlaque` (screen.c) and
  `R_RocketTrail`/`R_EntityParticles` (r_part.c) are called directly from
  cl_main.c in the C (same executable, ordinary extern calls) and are
  imported the same way here from the concurrent sibling units
  src/client/screen.ts (U051) and src/client/r_part.ts (U053), not through a
  hostClientHooks indirection -- unlike host.c, which needs the hooks because
  of the import-cycle rule documented in host.ts's own file header.
  `S_StopAllSounds` (sound.h/snd_dma.c) is imported the same way from
  src/client/snd_dma.ts (U054).
- `hostClientHooks`/`setForwardToServerHandler` registration happens at
  module load (a top-level call to `registerClMainHooks()`), not inside
  `CL_Init`, per this unit's brief: host.ts's dedicated-safe optional
  chaining (`hostClientHooks.x?.(...)`) must see every hook as soon as
  main.ts imports cl_main.ts, before Host_Init ever runs CL_Init.
- `hostClientHooks.flushCaches` (`D_FlushCaches`, called from
  `Host_ClearMemory`) is wired to `re.current?.D_FlushCaches()` rather than
  `getRenderer().D_FlushCaches()`: `Host_ClearMemory` runs unconditionally
  from `SV_SpawnServer`, including on a dedicated server with no renderer
  installed, and `D_FlushCaches` clearing renderer surface-cache memory that
  does not exist there is a harmless no-op, exactly as `getRenderer()`'s
  `Sys_Error`-on-null contract is meant to reject only genuine misuse.
- `hostClientHooks.clReadFromServer` discards `CL_ReadFromServer`'s `int`
  return value (the C's `CL_ReadFromServer` always returns 0 and no caller
  reads it either): the hook's declared shape is `(() => void) | null`.
- `Cmd_ForwardToServer`'s real body lives here (client.h's `cls` is this
  file's), ported byte-for-byte from cmd.c's `Cmd_ForwardToServer` (the unit
  brief pastes the exact C), and installed into cmd.ts's
  `setForwardToServerHandler` at module load alongside the hostClientHooks
  registration. cmd.ts keeps its own same-named `Cmd_ForwardToServer` as the
  "not connected" fallback that runs until this module installs the real one.
*/

import { Q_strcasecmp, va } from "../common/common";
import { Cbuf_InsertText, Cmd_AddCommand, Cmd_Args, Cmd_Argc, Cmd_Argv, setForwardToServerHandler } from "../common/cmd";
import { CvarT, Cvar_RegisterVariable } from "../common/cvar";
import type { Vec3 } from "../common/mathlib";
import { AngleVectors, VectorCopy, VectorMA, anglemod, vec3 } from "../common/mathlib";
import type { ModelT } from "../common/model";
import { EF_GIB, EF_GRENADE, EF_ROCKET, EF_ROTATE, EF_TRACER, EF_TRACER2, EF_TRACER3, EF_ZOMGIB } from "../common/model";
import { NET_CanSendMessage, NET_Close, NET_Connect, NET_SendMessage, NET_SendUnreliableMessage } from "../common/net_main";
import { ClcOpsT } from "../common/protocol";
import { MSG_WriteByte, MSG_WriteString, SZ_Alloc, SZ_Clear, SZ_Print } from "../common/sizebuf";
import { Cache_Report } from "../common/zone";
import { EF_BRIGHTFIELD, EF_BRIGHTLIGHT, EF_DIMLIGHT, EF_MUZZLEFLASH, sv } from "../server/server";
import { host, Host_ClearMemory, Host_Error, Host_ShutdownServer, hostClientHooks } from "../common/host";
import { Con_DPrintf, Con_Printf } from "./console";
import type { EntityT } from "./render";
import { getRenderer, re } from "./render";
import type { BeamT, DlightT, LightstyleT } from "./client";
import {
  CactiveT,
  MAX_DEMOS,
  MAX_DLIGHTS,
  MAX_EFRAGS,
  MAX_VISEDICTS,
  SIGNONS,
  UsercmdT,
  cl,
  cl_beams,
  cl_dlights,
  cl_efrags,
  cl_entities,
  cl_lightstyle,
  cl_temp_entities,
  cl_visedicts,
  clState,
  cls,
} from "./client";
import { chase_active } from "./chase";
import { inputBackend } from "./input";
import { SCR_BeginLoadingPlaque, SCR_EndLoadingPlaque } from "./screen";
import { R_EntityParticles, R_RocketTrail } from "./r_part";
import { CL_GetMessage, CL_PlayDemo_f, CL_Record_f, CL_Stop_f, CL_StopPlayback, CL_TimeDemo_f } from "./cl_demo";
import { CL_ParseServerMessage } from "./cl_parse";
import { CL_InitTEnts, CL_UpdateTEnts } from "./cl_tent";
import {
  CL_BaseMove,
  CL_InitInput,
  CL_SendMove,
  cl_anglespeedkey,
  cl_backspeed,
  cl_forwardspeed,
  cl_movespeedkey,
  cl_pitchspeed,
  cl_sidespeed,
  cl_upspeed,
  cl_yawspeed,
} from "./cl_input";
import { S_StopAllSounds } from "./snd_dma";

// we need to declare some mouse variables here, because the menu system
// references them even when on a unix system.

// these two are not intended to be set directly
export const cl_name = new CvarT("_cl_name", "player", true);
export const cl_color = new CvarT("_cl_color", "0", true);

export const cl_shownet = new CvarT("cl_shownet", "0"); // can be 0, 1, or 2
export const cl_nolerp = new CvarT("cl_nolerp", "0");

export const lookspring = new CvarT("lookspring", "0", true);
export const lookstrafe = new CvarT("lookstrafe", "0", true);
export const sensitivity = new CvarT("sensitivity", "3", true);

export const m_pitch = new CvarT("m_pitch", "0.022", true);
export const m_yaw = new CvarT("m_yaw", "0.022", true);
export const m_forward = new CvarT("m_forward", "1", true);
export const m_side = new CvarT("m_side", "0.8", true);

/*
=====================
CL_ClearState

=====================
*/
function clearDlight(dl: DlightT): void {
  dl.origin[0] = dl.origin[1] = dl.origin[2] = 0;
  dl.radius = 0;
  dl.die = 0;
  dl.decay = 0;
  dl.minlight = 0;
  dl.key = 0;
}

function clearEfrag(e: (typeof cl_efrags)[number]): void {
  e.leaf = null;
  e.leafnext = null;
  e.entity = null;
  e.entnext = null;
}

function clearLightstyle(l: LightstyleT): void {
  l.length = 0;
  l.map = "";
}

function clearBeam(b: BeamT): void {
  b.entity = 0;
  b.model = null;
  b.endtime = 0;
  b.start[0] = b.start[1] = b.start[2] = 0;
  b.end[0] = b.end[1] = b.end[2] = 0;
}

export function CL_ClearState(): void {
  if (!sv.active) Host_ClearMemory();

  // wipe the entire cl structure
  cl.clear();

  SZ_Clear(cls.message);

  // clear other arrays
  for (const e of cl_efrags) clearEfrag(e);
  for (const e of cl_entities) e.clear();
  for (const dl of cl_dlights) clearDlight(dl);
  for (const l of cl_lightstyle) clearLightstyle(l);
  for (const e of cl_temp_entities) e.clear();
  for (const b of cl_beams) clearBeam(b);

  //
  // allocate the efrags and chain together into a free list
  //
  cl.free_efrags = cl_efrags[0];
  let i: number;
  for (i = 0; i < MAX_EFRAGS - 1; i++) cl_efrags[i].entnext = cl_efrags[i + 1];
  cl_efrags[i].entnext = null;
}

/*
=====================
CL_Disconnect

Sends a disconnect message to the server
This is also called on Host_Error, so it shouldn't cause any errors
=====================
*/
export function CL_Disconnect(): void {
  // stop sounds (especially looping!)
  S_StopAllSounds(true);

  // bring the console down and fade the colors back to normal
  //	SCR_BringDownConsole ();

  // if running a local server, shut it down
  if (cls.demoplayback) CL_StopPlayback();
  else if (cls.state === CactiveT.ca_connected) {
    if (cls.demorecording) CL_Stop_f();

    Con_DPrintf("Sending clc_disconnect\n");
    SZ_Clear(cls.message);
    MSG_WriteByte(cls.message, ClcOpsT.clc_disconnect);
    NET_SendUnreliableMessage(cls.netcon, cls.message);
    SZ_Clear(cls.message);
    NET_Close(cls.netcon);

    cls.state = CactiveT.ca_disconnected;
    if (sv.active) Host_ShutdownServer(false);
  }

  cls.demoplayback = cls.timedemo = false;
  cls.signon = 0;
}

export function CL_Disconnect_f(): void {
  CL_Disconnect();
  if (sv.active) Host_ShutdownServer(false);
}

/*
=====================
CL_EstablishConnection

Host should be either "local" or a net address to be passed on
=====================
*/
export function CL_EstablishConnection(host: string): void {
  if (cls.state === CactiveT.ca_dedicated) return;

  if (cls.demoplayback) return;

  CL_Disconnect();

  cls.netcon = NET_Connect(host);
  if (cls.netcon === null) Host_Error("CL_Connect: connect failed\n");
  Con_DPrintf("CL_EstablishConnection: connected to %s\n", host);

  cls.demonum = -1; // not in the demo loop now
  cls.state = CactiveT.ca_connected;
  cls.signon = 0; // need all the signon messages before playing
}

/*
=====================
CL_SignonReply

An svc_signonnum has been received, perform a client side setup
=====================
*/
export function CL_SignonReply(): void {
  Con_DPrintf("CL_SignonReply: %i\n", cls.signon);

  switch (cls.signon) {
    case 1:
      MSG_WriteByte(cls.message, ClcOpsT.clc_stringcmd);
      MSG_WriteString(cls.message, "prespawn");
      break;

    case 2:
      MSG_WriteByte(cls.message, ClcOpsT.clc_stringcmd);
      MSG_WriteString(cls.message, va('name "%s"\n', cl_name.string));

      MSG_WriteByte(cls.message, ClcOpsT.clc_stringcmd);
      MSG_WriteString(cls.message, va("color %i %i\n", (cl_color.value | 0) >> 4, (cl_color.value | 0) & 15));

      MSG_WriteByte(cls.message, ClcOpsT.clc_stringcmd);
      MSG_WriteString(cls.message, va("spawn %s", cls.spawnparms));
      break;

    case 3:
      MSG_WriteByte(cls.message, ClcOpsT.clc_stringcmd);
      MSG_WriteString(cls.message, "begin");
      Cache_Report(); // print remaining memory
      break;

    case 4:
      SCR_EndLoadingPlaque(); // allow normal screen updates
      break;
  }
}

/*
=====================
CL_NextDemo

Called to play the next demo in the demo loop
=====================
*/
export function CL_NextDemo(): void {
  if (cls.demonum === -1) return; // don't play demos

  SCR_BeginLoadingPlaque();

  if (cls.demos[cls.demonum] === "" || cls.demonum === MAX_DEMOS) {
    cls.demonum = 0;
    if (cls.demos[cls.demonum] === "") {
      Con_Printf("No demos listed with startdemos\n");
      cls.demonum = -1;
      return;
    }
  }

  const str = va("playdemo %s\n", cls.demos[cls.demonum]);
  Cbuf_InsertText(str);
  cls.demonum++;
}

/*
==============
CL_PrintEntities_f
==============
*/
export function CL_PrintEntities_f(): void {
  for (let i = 0; i < cl.num_entities; i++) {
    const ent = cl_entities[i];
    Con_Printf("%3i:", i);
    if (ent.model === null) {
      Con_Printf("EMPTY\n");
      continue;
    }
    Con_Printf(
      "%s:%2i  (%5.1f,%5.1f,%5.1f) [%5.1f %5.1f %5.1f]\n",
      ent.model.name,
      ent.frame,
      ent.origin[0],
      ent.origin[1],
      ent.origin[2],
      ent.angles[0],
      ent.angles[1],
      ent.angles[2],
    );
  }
}

// SetPal is dead code (#if 0 in the C, see file header) -- not ported.

/*
===============
CL_AllocDlight

===============
*/
export function CL_AllocDlight(key: number): DlightT {
  // first look for an exact key match
  if (key) {
    for (let i = 0; i < MAX_DLIGHTS; i++) {
      const dl = cl_dlights[i];
      if (dl.key === key) {
        clearDlight(dl);
        dl.key = key;
        return dl;
      }
    }
  }

  // then look for anything else
  for (let i = 0; i < MAX_DLIGHTS; i++) {
    const dl = cl_dlights[i];
    if (dl.die < cl.time) {
      clearDlight(dl);
      dl.key = key;
      return dl;
    }
  }

  const dl = cl_dlights[0];
  clearDlight(dl);
  dl.key = key;
  return dl;
}

/*
===============
CL_DecayLights

===============
*/
export function CL_DecayLights(): void {
  const time = cl.time - cl.oldtime;

  for (let i = 0; i < MAX_DLIGHTS; i++) {
    const dl = cl_dlights[i];
    if (dl.die < cl.time || !dl.radius) continue;

    dl.radius -= time * dl.decay;
    if (dl.radius < 0) dl.radius = 0;
  }
}

/*
===============
CL_LerpPoint

Determines the fraction between the last two messages that the objects
should be put at.
===============
*/
export function CL_LerpPoint(): number {
  let f = cl.mtime[0] - cl.mtime[1];

  if (!f || cl_nolerp.value || cls.timedemo || sv.active) {
    cl.time = cl.mtime[0];
    return 1;
  }

  if (f > 0.1) {
    // dropped packet, or start of demo
    cl.mtime[1] = cl.mtime[0] - 0.1;
    f = 0.1;
  }

  let frac = (cl.time - cl.mtime[1]) / f;
  //Con_Printf ("frac: %f\n",frac);
  if (frac < 0) {
    if (frac < -0.01) {
      cl.time = cl.mtime[1];
      //				Con_Printf ("low frac\n");
    }
    frac = 0;
  } else if (frac > 1) {
    if (frac > 1.01) {
      cl.time = cl.mtime[0];
      //				Con_Printf ("high frac\n");
    }
    frac = 1;
  }

  return frac;
}

// rand() has no port-wide helper -- see file header's ruling
function rand31(): number {
  return Math.floor(Math.random() * 0x8000) & 31;
}

/*
===============
CL_RelinkEntities
===============
*/
export function CL_RelinkEntities(): void {
  // determine partial update time
  const frac = CL_LerpPoint();

  clState.cl_numvisedicts = 0;

  //
  // interpolate player info
  //
  for (let i = 0; i < 3; i++) cl.velocity[i] = cl.mvelocity[1][i] + frac * (cl.mvelocity[0][i] - cl.mvelocity[1][i]);

  if (cls.demoplayback) {
    // interpolate the angles
    for (let j = 0; j < 3; j++) {
      let d = cl.mviewangles[0][j] - cl.mviewangles[1][j];
      if (d > 180) d -= 360;
      else if (d < -180) d += 360;
      cl.viewangles[j] = cl.mviewangles[1][j] + frac * d;
    }
  }

  const bobjrotate = anglemod(100 * cl.time);

  // start on the entity after the world
  for (let i = 1; i < cl.num_entities; i++) {
    const ent: EntityT = cl_entities[i];

    if (ent.model === null) {
      // empty slot
      if (ent.forcelink) getRenderer().R_RemoveEfrags(ent); // just became empty
      continue;
    }

    // if the object wasn't included in the last packet, remove it
    if (ent.msgtime !== cl.mtime[0]) {
      ent.model = null;
      continue;
    }

    const model = ent.model;

    const oldorg: Vec3 = vec3();
    VectorCopy(ent.origin, oldorg);

    if (ent.forcelink) {
      // the entity was not updated in the last message
      // so move to the final spot
      VectorCopy(ent.msg_origins[0], ent.origin);
      VectorCopy(ent.msg_angles[0], ent.angles);
    } else {
      // if the delta is large, assume a teleport and don't lerp
      let f = frac;
      const delta: Vec3 = vec3();
      for (let j = 0; j < 3; j++) {
        delta[j] = ent.msg_origins[0][j] - ent.msg_origins[1][j];
        if (delta[j] > 100 || delta[j] < -100) f = 1; // assume a teleportation, not a motion
      }

      // interpolate the origin and angles
      for (let j = 0; j < 3; j++) {
        ent.origin[j] = ent.msg_origins[1][j] + f * delta[j];

        let d = ent.msg_angles[0][j] - ent.msg_angles[1][j];
        if (d > 180) d -= 360;
        else if (d < -180) d += 360;
        ent.angles[j] = ent.msg_angles[1][j] + f * d;
      }
    }

    // rotate binary objects locally
    if (model.flags & EF_ROTATE) ent.angles[1] = bobjrotate;

    if (ent.effects & EF_BRIGHTFIELD) R_EntityParticles(ent);

    if (ent.effects & EF_MUZZLEFLASH) {
      const fv: Vec3 = vec3();
      const rv: Vec3 = vec3();
      const uv: Vec3 = vec3();

      const dl = CL_AllocDlight(i);
      VectorCopy(ent.origin, dl.origin);
      dl.origin[2] += 16;
      AngleVectors(ent.angles, fv, rv, uv);

      VectorMA(dl.origin, 18, fv, dl.origin);
      dl.radius = 200 + rand31();
      dl.minlight = 32;
      dl.die = cl.time + 0.1;
    }
    if (ent.effects & EF_BRIGHTLIGHT) {
      const dl = CL_AllocDlight(i);
      VectorCopy(ent.origin, dl.origin);
      dl.origin[2] += 16;
      dl.radius = 400 + rand31();
      dl.die = cl.time + 0.001;
    }
    if (ent.effects & EF_DIMLIGHT) {
      const dl = CL_AllocDlight(i);
      VectorCopy(ent.origin, dl.origin);
      dl.radius = 200 + rand31();
      dl.die = cl.time + 0.001;
    }

    if (model.flags & EF_GIB) R_RocketTrail(oldorg, ent.origin, 2);
    else if (model.flags & EF_ZOMGIB) R_RocketTrail(oldorg, ent.origin, 4);
    else if (model.flags & EF_TRACER) R_RocketTrail(oldorg, ent.origin, 3);
    else if (model.flags & EF_TRACER2) R_RocketTrail(oldorg, ent.origin, 5);
    else if (model.flags & EF_ROCKET) {
      R_RocketTrail(oldorg, ent.origin, 0);
      const dl = CL_AllocDlight(i);
      VectorCopy(ent.origin, dl.origin);
      dl.radius = 200;
      dl.die = cl.time + 0.01;
    } else if (model.flags & EF_GRENADE) R_RocketTrail(oldorg, ent.origin, 1);
    else if (model.flags & EF_TRACER3) R_RocketTrail(oldorg, ent.origin, 6);

    ent.forcelink = false;

    if (i === cl.viewentity && !chase_active.value) continue;

    if (clState.cl_numvisedicts < MAX_VISEDICTS) {
      cl_visedicts[clState.cl_numvisedicts] = ent;
      clState.cl_numvisedicts++;
    }
  }
}

/*
===============
CL_ReadFromServer

Read all incoming data from the server
===============
*/
export function CL_ReadFromServer(): number {
  cl.oldtime = cl.time;
  cl.time += host.frametime;

  let ret: number;
  do {
    ret = CL_GetMessage();
    if (ret === -1) Host_Error("CL_ReadFromServer: lost server connection");
    if (!ret) break;

    cl.last_received_message = host.realtime;
    CL_ParseServerMessage();
  } while (ret && cls.state === CactiveT.ca_connected);

  if (cl_shownet.value) Con_Printf("\n");

  CL_RelinkEntities();
  CL_UpdateTEnts();

  //
  // bring the links up to date
  //
  return 0;
}

/*
=================
CL_SendCmd
=================
*/
export function CL_SendCmd(): void {
  const cmd = new UsercmdT();

  if (cls.state !== CactiveT.ca_connected) return;

  if (cls.signon === SIGNONS) {
    // get basic movement from keyboard
    CL_BaseMove(cmd);

    // allow mice or other external controllers to add to the move
    inputBackend.current?.IN_Move(cmd);

    // send the unreliable message
    CL_SendMove(cmd);
  }

  if (cls.demoplayback) {
    SZ_Clear(cls.message);
    return;
  }

  // send the reliable message
  if (!cls.message.cursize) return; // no message at all

  if (!NET_CanSendMessage(cls.netcon)) {
    Con_DPrintf("CL_WriteToServer: can't send\n");
    return;
  }

  if (NET_SendMessage(cls.netcon, cls.message) === -1) Host_Error("CL_WriteToServer: lost server connection");

  SZ_Clear(cls.message);
}

/*
=================
CL_Init
=================
*/
export function CL_Init(): void {
  SZ_Alloc(cls.message, 1024);

  CL_InitInput();
  CL_InitTEnts();

  //
  // register our commands
  //
  Cvar_RegisterVariable(cl_name);
  Cvar_RegisterVariable(cl_color);
  Cvar_RegisterVariable(cl_upspeed);
  Cvar_RegisterVariable(cl_forwardspeed);
  Cvar_RegisterVariable(cl_backspeed);
  Cvar_RegisterVariable(cl_sidespeed);
  Cvar_RegisterVariable(cl_movespeedkey);
  Cvar_RegisterVariable(cl_yawspeed);
  Cvar_RegisterVariable(cl_pitchspeed);
  Cvar_RegisterVariable(cl_anglespeedkey);
  Cvar_RegisterVariable(cl_shownet);
  Cvar_RegisterVariable(cl_nolerp);
  Cvar_RegisterVariable(lookspring);
  Cvar_RegisterVariable(lookstrafe);
  Cvar_RegisterVariable(sensitivity);

  Cvar_RegisterVariable(m_pitch);
  Cvar_RegisterVariable(m_yaw);
  Cvar_RegisterVariable(m_forward);
  Cvar_RegisterVariable(m_side);

  //	Cvar_RegisterVariable (&cl_autofire);

  Cmd_AddCommand("entities", CL_PrintEntities_f);
  Cmd_AddCommand("disconnect", CL_Disconnect_f);
  Cmd_AddCommand("record", CL_Record_f);
  Cmd_AddCommand("stop", CL_Stop_f);
  Cmd_AddCommand("playdemo", CL_PlayDemo_f);
  Cmd_AddCommand("timedemo", CL_TimeDemo_f);
}

//=============================================================================
// cmd.c's Cmd_ForwardToServer -- see file header's deviation note.

/*
===================
Cmd_ForwardToServer

Sends the entire command line over to the server
===================
*/
function Cmd_ForwardToServer(): void {
  if (cls.state !== CactiveT.ca_connected) {
    Con_Printf('Can\'t "%s", not connected\n', Cmd_Argv(0));
    return;
  }

  if (cls.demoplayback) return; // not really connected

  MSG_WriteByte(cls.message, ClcOpsT.clc_stringcmd);
  if (Q_strcasecmp(Cmd_Argv(0), "cmd") !== 0) {
    SZ_Print(cls.message, Cmd_Argv(0));
    SZ_Print(cls.message, " ");
  }
  if (Cmd_Argc() > 1) SZ_Print(cls.message, Cmd_Args() ?? "");
  else SZ_Print(cls.message, "\n");
}

//=============================================================================
// hostClientHooks / setForwardToServerHandler registration -- see file
// header's deviation note: this runs at module load, not inside CL_Init.

function registerClMainHooks(): void {
  hostClientHooks.clDisconnect = CL_Disconnect;
  hostClientHooks.clDisconnectF = CL_Disconnect_f;
  hostClientHooks.clEstablishConnection = CL_EstablishConnection;
  hostClientHooks.clNextDemo = CL_NextDemo;
  hostClientHooks.clSendCmd = CL_SendCmd;
  hostClientHooks.clReadFromServer = () => {
    CL_ReadFromServer();
  };
  hostClientHooks.clDecayLights = CL_DecayLights;
  hostClientHooks.clInit = CL_Init;

  hostClientHooks.clsStateConnected = () => cls.state === CactiveT.ca_connected;
  hostClientHooks.setClsStateDedicated = () => {
    cls.state = CactiveT.ca_dedicated;
  };
  hostClientHooks.setClsStateDisconnected = () => {
    cls.state = CactiveT.ca_disconnected;
  };
  hostClientHooks.clsTimedemo = () => cls.timedemo;
  hostClientHooks.clsDemoplayback = () => cls.demoplayback;
  hostClientHooks.clsSignonComplete = () => cls.signon === SIGNONS;
  hostClientHooks.clsSignonZero = () => {
    cls.signon = 0;
  };
  hostClientHooks.clsDemonum = () => cls.demonum;
  hostClientHooks.setClsDemonum = (n: number) => {
    cls.demonum = n;
  };
  hostClientHooks.setClsDemos = (i: number, name: string) => {
    cls.demos[i] = name;
  };
  hostClientHooks.setClsMapstring = (s: string) => {
    cls.mapstring = s;
  };
  hostClientHooks.setClsSpawnparms = (s: string) => {
    cls.spawnparms = s;
  };

  hostClientHooks.clIntermission = () => cl.intermission;
  hostClientHooks.clLevelname = () => cl.levelname;
  hostClientHooks.clStat = (n: number) => cl.stats[n];
  hostClientHooks.clModelPrecache = (n: number) => cl.model_precache[n];
  hostClientHooks.setClModelPrecache = (n: number, m: ModelT) => {
    cl.model_precache[n] = m;
  };
  hostClientHooks.clNameString = () => cl_name.string;
  hostClientHooks.clColorValue = () => cl_color.value;

  hostClientHooks.flushCaches = () => {
    re.current?.D_FlushCaches(); // D_FlushCaches -- see file header: harmless no-op on a dedicated server
  };
  hostClientHooks.clearClient = () => {
    cls.signon = 0;
    cl.clear();
  };
}

registerClMainHooks();
setForwardToServerHandler(Cmd_ForwardToServer);
