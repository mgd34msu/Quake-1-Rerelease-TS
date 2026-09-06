/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/server/pr_cmds.c (GNU GPL v2 or later), diffed with `diff -w`
against WinQuake/pr_cmds.c (684 changed lines) and against the already-landed
WinQuake port, src/progs/pr_cmds.ts, which this file mirrors structure,
names, order, and idiom from wherever the QW source does not differ.

Real QW deltas from WinQuake/pr_cmds.c (checked against the actual QW source
file, not the unit brief's paraphrase -- see the deviation notes below for
several places the brief's guess did not match what QW/server/pr_cmds.c
actually contains):
- `PR_GetString(pr_xfunction->s_name)` replaces the WinQuake pointer-
  difference read in PF_error/PF_objerror; `SV_Error` (pr_exec.ts's stand-in,
  see below) replaces `Host_Error`.
- `SetMinMaxSize` does not exist in this file at all -- QW's PF_setsize
  inlines `VectorCopy(min,mins); VectorCopy(max,maxs); VectorSubtract(...,
  size); SV_LinkEdict(e,false)` directly, with no rotation branch and no
  `rotate`/`rotateArg` dead code. The unit brief's instruction to "port
  SetMinMaxSize's rotation branch as in the C" does not match the source
  actually read for this port (same category of brief/source mismatch the
  WinQuake unit's own file header already flagged for PF_setmodel) -- there
  is no SetMinMaxSize function, live or dead, in QW/server/pr_cmds.c.
- PF_setmodel: no rotation, no SetMinMaxSize call at all. `e->v.model =
  PR_SetString(m)` allocates a fresh engine string from the model's content
  (QW's progs.ts genuinely exports `PR_SetString`, unlike WinQuake, so no
  "keep the parameter's raw string_t" workaround is needed here). Inline
  brush models (`m[0] === '*'`) additionally re-`Mod_ForName` the model and
  copy its mins/maxs/size, then `SV_LinkEdict`; non-inline models get no
  size information at all (no `sv.models[i]` lookup survives in this file).
- PF_bprint/PF_sprint gain a `level` parameter (`G_FLOAT(OFS_PARM0)`/
  `OFS_PARM1`), shifting `PF_VarString`'s `first` argument by one, and go
  through `SV_BroadcastPrintf`/`SV_ClientPrintf` (sv_send.ts) instead of a
  raw `MSG_WriteChar`+`MSG_WriteString` into `client->message` (QW's
  `client_t` has no such field at all -- see server.ts's own file header).
- PF_centerprint keeps its old (clientent, value) shape but now writes
  through `ClientReliableWrite_Begin`/`ClientReliableWrite_String`
  (sv_nchan.ts) instead of `client->message`.
- PF_particle is gone entirely -- no function, no `SV_StartParticle` import;
  its builtin slot (#46, WinQuake's `PF_particle`) becomes `PF_Fixme`.
- PF_sound drops WinQuake's three `Sys_Error` range checks on
  channel/volume/attenuation (QW trusts the QuakeC caller here).
- PF_checkclient/PF_newcheckclient/PF_stuffcmd/PF_setspawnparms/PF_logfrag/
  PF_infokey/PF_lightstyle: `MAX_CLIENTS` (protocol.ts) replaces
  `svs.maxclients`, which does not exist on QW's `server_static_t` at all
  (server.ts's own file header already documents this field's removal).
- PF_stuffcmd's body is entirely different: a literal `"disconnect\n"`
  short-circuits to `cl.drop = true`, otherwise the string goes through
  `ClientReliableWrite_Begin`/`ClientReliableWrite_String` (svc_stufftext).
  No more `host_client`/`Host_ClientCommands` dance (qwsv has no host.c at
  all, per pr_exec.ts's/qwsvdef.ts's own file headers).
- PF_dprint calls `Con_Printf`, not `Con_DPrintf` (checked: real delta, not a
  typo in the diff).
- PF_ftos/PF_vtos: `PR_SetString` in place of the WinQuake pointer-difference
  write (this progs.ts already exports it under that name).
- PF_precache_model drops the `sv.models[i] = Mod_ForName(s, true)` line
  entirely -- QW does not preload the model at precache time.
- PF_lightstyle: `client.state === cs_spawned` replaces `active || spawned`
  (QW's `client_t` uses one state enum, not two booleans); writes go through
  `ClientReliableWrite_Begin`/`Char`/`String` instead of raw `MSG_Write*`
  into `client->message`.
- `sv_aim`'s default is `"2"`, not `"0.93"` -- the C keeps the old value as
  a dead `//`-commented-out declaration directly above the live one; ported
  as a comment for the same reason SetMinMaxSize's old rotation branch was
  kept as a comment in the WinQuake port (documents real prior art, isn't
  live code).
- PF_aim gains a "noaim" option: for a client entity, `Info_ValueForKey` on
  `userinfo` for `"noaim"`, and if `Q_atoi` of that is positive, returns
  `v_forward` immediately (skipping every trace). Inserted where the C
  inserts it: right after `start[2] += 20`, before the straight-trace check.
  The C also reads `speed = G_FLOAT(OFS_PARM1)` before this and never uses
  it again (`missilespeed` is dead here in both C trees); the already-landed
  WinQuake port omits this dead, side-effect-free read entirely, and this
  port matches that precedent rather than reintroducing an unused local.
- MESSAGE WRITING: `MSG_MULTICAST` (4) is new. `WriteDest`'s `MSG_ONE` case
  is now dead code in the C itself -- `SV_Error("Shouldn't be at MSG_ONE")`
  (typed `never` in pr_exec.ts, so this genuinely cannot fall through)
  precedes an `#if 0` block that is never reached; the `#if 0` body is
  dropped per PORTING.md's `#if 0` rule rather than ported unreachable.
  `MSG_INIT` gains a `sv.state !== ss_loading` guard. `MSG_MULTICAST`
  returns `sv.multicast`. A new module-private `Write_GetClient()` resolves
  `msg_entity` to a `ClientT` for the real `MSG_ONE` path (routed through
  `ClientReliableCheckBlock`/`ClientReliableWrite_*`, sv_nchan.ts, not
  `WriteDest()` at all); every `PF_Write*` gains an
  `if (dest === MSG_ONE) {...} else {...WriteDest()...}` branch.
- PF_makestatic's `SV_ModelIndex` now resolves to sv_init.ts's real
  implementation (landed concurrently with this unit) rather than a
  not-yet-landed placeholder.
- PF_changelevel: `svs.changelevel_issued` does not exist on QW's
  `server_static_t` (same field-removal as `maxclients`, above); replaced
  with a module-private `static int last_spawncount` compared against
  `svs.spawncount` (which does exist), matching the C's own guard exactly.
  `Cbuf_AddText("map %s\n")` replaces `"changelevel %s\n"`.
- Four new builtins, appended after `PF_setspawnparms` in both the source
  file and the builtin table: `PF_logfrag` (writes a `\name1\name2\` line to
  `svs.log[svs.logsequence & 1]` via `SZ_Print`, and to
  `svSendFileState.sv_fraglogfile` via `Sys_FileWrite` when that fd is
  open -- both fields live in sv_send.ts per that file's own file header,
  which already documents pr_cmds.ts as this field's other reader),
  `PF_infokey` (serverinfo/localinfo for entity 0; `"ip"`/`"ping"` special-
  cased then `userinfo` for a client entity; `""` otherwise), `PF_stof`
  (`Q_atof`, common.ts), and `PF_multicast` (`SV_Multicast`, sv_send.ts).
  `RETURN_STRING` (a new `#define` in this file, not carried over from
  WinQuake) is ported as a small helper function, the same treatment
  `RETURN_EDICT` already gets in progs.ts.

Deviations carried over unchanged from the WinQuake port (same reasoning,
not repeated in full -- see src/progs/pr_cmds.ts's own file header):
- `PF_VarString`'s C `static char out[256]` truncation has no TS equivalent
  and is ported as unbounded string concatenation.
- `PF_error`/`PF_objerror` read `pr_xfunction`'s name unchecked in the C;
  `xfunctionName()` below guards it the same way, for the same reason
  (pr_cmds.test.ts drives builtins directly, without `PR_ExecuteProgram`
  ever having run).
- `PF_break`'s `*(int *)-4 = 0;` (dump to debugger) has no TS equivalent;
  dropped as a no-op after the `Con_Printf`, matching the C's own
  commented-out `PR_RunError` alternative in spirit.
- `PF_random`'s `rand()` has no libc equivalent:
  `Math.floor(Math.random() * 0x8000) & 0x7fff`.
- `PF_checkclient`/`PF_newcheckclient`'s `checkpvs[MAX_MAP_LEAFS/8]` is a
  module-private `Uint8Array`. `leaf - sv.worldmodel->leafs` becomes
  `worldmodel.leafs.indexOf(leaf)`.
- `PF_droptofloor`'s `ent->v.groundentity = EDICT_TO_PROG(trace.ent)` derefs
  `trace.ent` unchecked in the C; this port only reaches that line when
  `fraction < 1`, which world.ts's move/clip functions guarantee sets
  `trace.ent`, so a `SysError` guard replaces the unchecked dereference.
- `PF_setmodel`'s new inline-model branch calls `Mod_ForName(m, true)`,
  typed `ModelT | null` by this port's `model.ts`; a `SysError` guard
  covers the type-only possibility the same way, for the same reason.
- `PF_Find`'s `if (!s) PR_RunError(...)`/`if (!t) continue;` (bug fix,
  2026-09-05, D.md Defect B, same as src/progs/pr_cmds.ts's identical fix):
  both test a `char *` that is never NULL in the C, so both are dead code
  and are dropped here rather than ported as JS truthiness, which fired on
  an empty (unset) `.target`/etc. field. See PF_Find's own comment.

Deviations specific to this being qwsv's own progs host (see this unit's
sibling files' own headers for the established precedent each one sets):
- `Con_Printf`/`Con_DPrintf`: imported from `./sv_send`, not
  `../../client/console`. qwsvdef.ts's and sv_send.ts's own file headers
  both document that qwsv has no console.c of its own -- sv_send.ts's
  redirect-aware `Con_Printf`/`Con_DPrintf` are the only symbols of those
  names actually linked into the qwsv binary, and every other qwsv-server
  file in this SCOPE already imports them from there. This is a real
  deviation from this unit's brief text (which named `src/client/console`),
  followed here to match the established real link graph instead.
- `SV_ModelIndex`/`localinfoState` (sv_init.ts) are landed and imported
  normally. `teamplay` (cvar) and `SV_CalcPing` are sv_main.c-owned and
  sv_main.ts (Q014) has not landed as of this unit; imported from
  `./sv_main` normally, per this unit's brief. `SV_movestep`/
  `SV_CheckBottom`/`SV_MoveToGoal` (sv_move.c-owned, Q016, not landed) are
  imported from `./sv_move` normally, same treatment. Per the brief, the
  only acceptable `bun run check` failures traceable to this file are
  "Cannot find module './sv_main'" / "'./sv_move'" and errors on the
  unresolved names (`teamplay`, `SV_CalcPing`, `SV_movestep`,
  `SV_CheckBottom`, `SV_MoveToGoal`).
- `sv_aim` is defined here, matching the WinQuake port's identical ruling:
  it is genuinely owned by pr_cmds.c in both C trees (not sv_main.c/
  sv_init.c), so no sibling module will ever supersede it.
*/

import { Cbuf_AddText } from "../../common/cmd";
import { Com_sprintf } from "../../common/sprintf";
import { Q_atof, Q_atoi } from "../../common/common";
import { CvarT, Cvar_RegisterVariable, Cvar_Set, Cvar_VariableValue } from "../../common/cvar";
import {
  AngleVectors,
  DotProduct,
  Length,
  M_PI,
  VectorAdd,
  VectorCopy,
  VectorMA,
  VectorNormalize,
  VectorScale,
  VectorSubtract,
  anglemod,
  vec3,
  vec3_origin,
  type Vec3,
} from "../../common/mathlib";
import { Mod_LeafPVS, Mod_PointInLeaf, type ModelT } from "../../common/model";
import { MAX_MAP_LEAFS } from "../../common/bspfile";
import { MSG_WriteAngle, MSG_WriteByte, MSG_WriteChar, MSG_WriteCoord, MSG_WriteLong, MSG_WriteShort, MSG_WriteString, SizeBuf, SZ_Print } from "../../common/sizebuf";
import { Sys_Error, Sys_FileWrite, SysError } from "../../platform/sys";
import { MAX_MODELS, MAX_SOUNDS } from "../bothdefs";
import { MAX_CLIENTS, SvcOpsT } from "../protocol";
import { NET_BaseAdrToString } from "../net_udp";
import { Mod_ForName } from "./model";
import { QW_GLOBAL_OFS, type QwGlobalVars } from "./progdefs";
import {
  EDICT_NUM,
  EDICT_TO_PROG,
  E_STRING,
  G_EDICT,
  G_EDICTNUM,
  G_FLOAT,
  G_INT,
  G_STRING,
  G_VECTOR,
  NUM_FOR_EDICT,
  PROG_TO_EDICT,
  PR_GetString,
  PR_SetString,
  PR_SetStringRef,
  QwEdictT,
  RETURN_EDICT,
  qwpr,
} from "./progs";
import { ED_Alloc, ED_Free, ED_Print, ED_PrintEdicts, ED_PrintNum } from "./pr_edict";
import { OFS_PARM0, OFS_PARM1, OFS_PARM2, OFS_PARM3, OFS_PARM4, OFS_RETURN, type StringT } from "../../progs/pr_comp";
import { PR_RunError, SV_Error, prExec, setBuiltins, type BuiltinT } from "./pr_exec";
import {
  DAMAGE_AIM,
  FL_FLY,
  FL_NOTARGET,
  FL_ONGROUND,
  FL_SWIM,
  NUM_SPAWN_PARMS,
  ServerStateT,
  SOLID_NOT,
  svState,
  sv,
  svs,
  ClientStateT,
  ClientT,
} from "./server";
import { MOVE_NORMAL, SV_LinkEdict, SV_Move, SV_PointContents } from "./world";
import { Con_Printf, SV_BroadcastPrintf, SV_ClientPrintf, SV_Multicast, SV_StartSound, svSendFileState } from "./sv_send";
import { ClientReliableCheckBlock, ClientReliableWrite_Angle, ClientReliableWrite_Begin, ClientReliableWrite_Byte, ClientReliableWrite_Char, ClientReliableWrite_Coord, ClientReliableWrite_Long, ClientReliableWrite_Short, ClientReliableWrite_String } from "./sv_nchan";
import { Info_ValueForKey } from "../common";
import { localinfoState, SV_ModelIndex } from "./sv_init";
import { teamplay, SV_CalcPing } from "./sv_main";
import { SV_CheckBottom, SV_MoveToGoal, SV_movestep } from "./sv_move";

//============================================================================
// small module-private guards, matching the pattern src/progs/pr_cmds.ts and
// this track's own progs.ts/pr_exec.ts/pr_edict.ts/world.ts already
// establish (each file keeps its own copy rather than sharing one).

function globals(): { f: Float32Array; i: Int32Array } {
  if (qwpr.globals === null) throw new SysError("pr_cmds.ts: qwpr.globals not set (PR_LoadProgs not called)");
  return qwpr.globals;
}

function requireGlobalStruct(): QwGlobalVars {
  if (qwpr.global_struct === null) throw new SysError("pr_cmds.ts: qwpr.global_struct not set (PR_LoadProgs not called)");
  return qwpr.global_struct;
}

function requireWorldmodel(): ModelT {
  if (sv.worldmodel === null) throw new SysError("pr_cmds.ts: sv.worldmodel not set");
  return sv.worldmodel;
}

// see file header's PF_error/PF_objerror deviation note
function xfunctionName(): string {
  const xf = prExec.xfunction;
  return xf ? PR_GetString(xf.s_name) : "";
}

// #define RETURN_STRING(s) (((int *)pr_globals)[OFS_RETURN] = PR_SetString(s))
function RETURN_STRING(s: string): void {
  globals().i[OFS_RETURN] = PR_SetString(s);
}

// PF_logfrag's fprintf target is a raw fd (svSendFileState.sv_fraglogfile);
// same private helper sv_send.ts keeps for its own Sys_FileWrite calls.
function stringToLatin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/*
===============
PF_VarString
===============
*/
function PF_VarString(first: number): string {
  let out = "";
  for (let i = first; i < prExec.argc; i++) {
    out += G_STRING(OFS_PARM0 + i * 3);
  }
  return out;
}

/*
=================
PF_errror

This is a TERMINAL error, which will kill off the entire server.
Dumps self.

error(value)
=================
*/
function PF_error(): void {
  const s = PF_VarString(0);
  Con_Printf("======SERVER ERROR in %s:\n%s\n", xfunctionName(), s);
  const ed = PROG_TO_EDICT(requireGlobalStruct().self);
  ED_Print(ed);

  SV_Error("Program error");
}

/*
=================
PF_objerror

Dumps out self, then an error message.  The program is aborted and self is
removed, but the level can continue.

objerror(value)
=================
*/
function PF_objerror(): void {
  const s = PF_VarString(0);
  Con_Printf("======OBJECT ERROR in %s:\n%s\n", xfunctionName(), s);
  const ed = PROG_TO_EDICT(requireGlobalStruct().self);
  ED_Print(ed);
  ED_Free(ed);

  SV_Error("Program error");
}

/*
==============
PF_makevectors

Writes new values for v_forward, v_up, and v_right based on angles
makevectors(vector)
==============
*/
function PF_makevectors(): void {
  const gs = requireGlobalStruct();
  AngleVectors(G_VECTOR(OFS_PARM0), gs.v_forward, gs.v_right, gs.v_up);
}

/*
=================
PF_setorigin

This is the only valid way to move an object without using the physics of
the world (setting velocity and waiting). Directly changing origin will not
set internal links correctly, so clipping would be messed up. This should
be called when an object is spawned, and then only if it is teleported.

setorigin (entity, origin)
=================
*/
function PF_setorigin(): void {
  const e = G_EDICT(OFS_PARM0);
  const org = G_VECTOR(OFS_PARM1);
  VectorCopy(org, e.v.origin);
  SV_LinkEdict(e, false);
}

/*
=================
PF_setsize

the size box is rotated by the current angle

setsize (entity, minvector, maxvector)
=================
*/
function PF_setsize(): void {
  const e = G_EDICT(OFS_PARM0);
  const min = G_VECTOR(OFS_PARM1);
  const max = G_VECTOR(OFS_PARM2);
  VectorCopy(min, e.v.mins);
  VectorCopy(max, e.v.maxs);
  VectorSubtract(max, min, e.v.size);
  SV_LinkEdict(e, false);
}

/*
=================
PF_setmodel

setmodel(entity, model)
Also sets size, mins, and maxs for inline bmodels
=================
*/
function PF_setmodel(): void {
  const e = G_EDICT(OFS_PARM0);
  const m = G_STRING(OFS_PARM1);

  // check to see if model was properly precached
  let i = 0;
  while (sv.model_precache[i] !== null && sv.model_precache[i] !== m) i++;

  if (sv.model_precache[i] === null) PR_RunError("no precache: %s\n", m);

  e.v.model = PR_SetString(m);
  e.v.modelindex = i;

  // if it is an inline model, get the size information for it
  if (m[0] === "*") {
    const mod = Mod_ForName(m, true);
    if (mod === null) throw new SysError("PF_setmodel: Mod_ForName returned null for inline model");
    VectorCopy(mod.mins, e.v.mins);
    VectorCopy(mod.maxs, e.v.maxs);
    VectorSubtract(mod.maxs, mod.mins, e.v.size);
    SV_LinkEdict(e, false);
  }
}

/*
=================
PF_bprint

broadcast print to everyone on server

bprint(value)
=================
*/
function PF_bprint(): void {
  const level = G_FLOAT(OFS_PARM0) | 0;
  const s = PF_VarString(1);
  SV_BroadcastPrintf(level, "%s", s);
}

/*
=================
PF_sprint

single print to a specific client

sprint(clientent, value)
=================
*/
function PF_sprint(): void {
  const entnum = G_EDICTNUM(OFS_PARM0);
  const level = G_FLOAT(OFS_PARM1) | 0;
  const s = PF_VarString(2);

  if (entnum < 1 || entnum > MAX_CLIENTS) {
    Con_Printf("tried to sprint to a non-client\n");
    return;
  }

  const client = svs.clients[entnum - 1];

  SV_ClientPrintf(client, level, "%s", s);
}

/*
=================
PF_centerprint

single print to a specific client

centerprint(clientent, value)
=================
*/
function PF_centerprint(): void {
  const entnum = G_EDICTNUM(OFS_PARM0);
  const s = PF_VarString(1);

  if (entnum < 1 || entnum > MAX_CLIENTS) {
    Con_Printf("tried to sprint to a non-client\n");
    return;
  }

  const cl = svs.clients[entnum - 1];

  ClientReliableWrite_Begin(cl, SvcOpsT.svc_centerprint, 2 + s.length);
  ClientReliableWrite_String(cl, s);
}

/*
=================
PF_normalize

vector normalize(vector)
=================
*/
function PF_normalize(): void {
  const value1 = G_VECTOR(OFS_PARM0);

  let newlen = value1[0] * value1[0] + value1[1] * value1[1] + value1[2] * value1[2];
  newlen = Math.sqrt(newlen);

  const newvalue = vec3();
  if (newlen === 0) {
    newvalue[0] = newvalue[1] = newvalue[2] = 0;
  } else {
    const inv = 1 / newlen;
    newvalue[0] = value1[0] * inv;
    newvalue[1] = value1[1] * inv;
    newvalue[2] = value1[2] * inv;
  }

  VectorCopy(newvalue, G_VECTOR(OFS_RETURN));
}

/*
=================
PF_vlen

scalar vlen(vector)
=================
*/
function PF_vlen(): void {
  const value1 = G_VECTOR(OFS_PARM0);
  const newlen = Math.sqrt(value1[0] * value1[0] + value1[1] * value1[1] + value1[2] * value1[2]);
  globals().f[OFS_RETURN] = newlen;
}

/*
=================
PF_vectoyaw

float vectoyaw(vector)
=================
*/
function PF_vectoyaw(): void {
  const value1 = G_VECTOR(OFS_PARM0);
  let yaw: number;

  if (value1[1] === 0 && value1[0] === 0) yaw = 0;
  else {
    yaw = Math.trunc((Math.atan2(value1[1], value1[0]) * 180) / M_PI);
    if (yaw < 0) yaw += 360;
  }

  globals().f[OFS_RETURN] = yaw;
}

/*
=================
PF_vectoangles

vector vectoangles(vector)
=================
*/
function PF_vectoangles(): void {
  const value1 = G_VECTOR(OFS_PARM0);
  let yaw: number;
  let pitch: number;

  if (value1[1] === 0 && value1[0] === 0) {
    yaw = 0;
    pitch = value1[2] > 0 ? 90 : 270;
  } else {
    yaw = Math.trunc((Math.atan2(value1[1], value1[0]) * 180) / M_PI);
    if (yaw < 0) yaw += 360;

    const forward = Math.sqrt(value1[0] * value1[0] + value1[1] * value1[1]);
    pitch = Math.trunc((Math.atan2(value1[2], forward) * 180) / M_PI);
    if (pitch < 0) pitch += 360;
  }

  const g = globals();
  g.f[OFS_RETURN + 0] = pitch;
  g.f[OFS_RETURN + 1] = yaw;
  g.f[OFS_RETURN + 2] = 0;
}

/*
=================
PF_Random

Returns a number from 0<= num < 1

random()
=================
*/
function PF_random(): void {
  // rand() has no libc equivalent; see src/progs/pr_cmds.ts's identical ruling
  const num = (Math.floor(Math.random() * 0x8000) & 0x7fff) / 0x7fff;
  globals().f[OFS_RETURN] = num;
}

/*
=================
PF_ambientsound
=================
*/
function PF_ambientsound(): void {
  const pos = G_VECTOR(OFS_PARM0);
  const samp = G_STRING(OFS_PARM1);
  const vol = G_FLOAT(OFS_PARM2);
  const attenuation = G_FLOAT(OFS_PARM3);

  // check to see if samp was properly precached
  let soundnum = 0;
  while (sv.sound_precache[soundnum] !== null && sv.sound_precache[soundnum] !== samp) soundnum++;

  if (sv.sound_precache[soundnum] === null) {
    Con_Printf("no precache: %s\n", samp);
    return;
  }

  // add an svc_spawnambient command to the level signon packet
  MSG_WriteByte(sv.signon, SvcOpsT.svc_spawnstaticsound);
  for (let i = 0; i < 3; i++) MSG_WriteCoord(sv.signon, pos[i]);

  MSG_WriteByte(sv.signon, soundnum);

  MSG_WriteByte(sv.signon, vol * 255);
  MSG_WriteByte(sv.signon, attenuation * 64);
}

/*
=================
PF_sound

Each entity can have eight independant sound sources, like voice,
weapon, feet, etc.

Channel 0 is an auto-allocate channel, the others override anything
allready running on that entity/channel pair.

An attenuation of 0 will play full volume everywhere in the level.
Larger attenuations will drop off.
=================
*/
function PF_sound(): void {
  const entity = G_EDICT(OFS_PARM0);
  const channel = G_FLOAT(OFS_PARM1) | 0;
  const sample = G_STRING(OFS_PARM2);
  const volume = (G_FLOAT(OFS_PARM3) * 255) | 0;
  const attenuation = G_FLOAT(OFS_PARM4);

  SV_StartSound(entity, channel, sample, volume, attenuation);
}

/*
=================
PF_break

break()
=================
*/
function PF_break(): void {
  Con_Printf("break statement\n");
  // *(int *)-4 = 0; // dump to debugger -- no TS equivalent, see file header
}

/*
=================
PF_traceline

Used for use tracing and shot targeting
Traces are blocked by bbox and exact bsp entityes, and also slide box
entities if the tryents flag is set.

traceline (vector1, vector2, tryents)
=================
*/
function PF_traceline(): void {
  const v1 = G_VECTOR(OFS_PARM0);
  const v2 = G_VECTOR(OFS_PARM1);
  const nomonsters = G_FLOAT(OFS_PARM2) | 0;
  const ent = G_EDICT(OFS_PARM3);

  const trace = SV_Move(v1, vec3_origin, vec3_origin, v2, nomonsters, ent);

  const gs = requireGlobalStruct();
  gs.trace_allsolid = trace.allsolid ? 1 : 0;
  gs.trace_startsolid = trace.startsolid ? 1 : 0;
  gs.trace_fraction = trace.fraction;
  gs.trace_inwater = trace.inwater ? 1 : 0;
  gs.trace_inopen = trace.inopen ? 1 : 0;
  VectorCopy(trace.endpos, gs.trace_endpos);
  VectorCopy(trace.plane.normal, gs.trace_plane_normal);
  gs.trace_plane_dist = trace.plane.dist;
  if (trace.ent) gs.trace_ent = EDICT_TO_PROG(trace.ent);
  else gs.trace_ent = EDICT_TO_PROG(sv.edicts[0]);
}

/*
=================
PF_checkpos

Returns true if the given entity can move to the given position from it's
current position by walking or rolling.
FIXME: make work...
scalar checkpos (entity, vector)
=================
*/
function PF_checkpos(): void {}

//============================================================================

const checkpvs = new Uint8Array(MAX_MAP_LEAFS / 8);

/*
===============
PF_newcheckclient
===============
*/
function PF_newcheckclient(checkIn: number): number {
  // cycle to the next one
  let check = checkIn;
  if (check < 1) check = 1;
  if (check > MAX_CLIENTS) check = MAX_CLIENTS;

  let i = check === MAX_CLIENTS ? 1 : check + 1;

  let ent: QwEdictT = EDICT_NUM(i);
  for (;;) {
    if (i === MAX_CLIENTS + 1) i = 1;

    ent = EDICT_NUM(i);

    if (i === check) break; // didn't find anything else

    if (ent.free) {
      i++;
      continue;
    }
    if (ent.v.health <= 0) {
      i++;
      continue;
    }
    if ((ent.v.flags | 0) & FL_NOTARGET) {
      i++;
      continue;
    }

    // anything that is a client, or has a client as an enemy
    break;
  }

  // get the PVS for the entity
  const org = vec3();
  VectorAdd(ent.v.origin, ent.v.view_ofs, org);
  const worldmodel = requireWorldmodel();
  const leaf = Mod_PointInLeaf(org, worldmodel);
  const pvs = Mod_LeafPVS(leaf, worldmodel);
  const numBytes = (worldmodel.numleafs + 7) >> 3;
  checkpvs.set(pvs.subarray(0, numBytes));

  return i;
}

/*
=================
PF_checkclient

Returns a client (or object that has a client enemy) that would be a
valid target.

If there are more than one valid options, they are cycled each frame

If (self.origin + self.viewofs) is not in the PVS of the current target,
it is not returned at all.

name checkclient ()
=================
*/
let c_invis = 0;
let c_notvis = 0;

function PF_checkclient(): void {
  // find a new check if on a new frame
  if (sv.time - sv.lastchecktime >= 0.1) {
    sv.lastcheck = PF_newcheckclient(sv.lastcheck);
    sv.lastchecktime = sv.time;
  }

  // return check if it might be visible
  const ent = EDICT_NUM(sv.lastcheck);
  if (ent.free || ent.v.health <= 0) {
    RETURN_EDICT(sv.edicts[0]);
    return;
  }

  // if current entity can't possibly see the check entity, return 0
  const gs = requireGlobalStruct();
  const self = PROG_TO_EDICT(gs.self);
  const view = vec3();
  VectorAdd(self.v.origin, self.v.view_ofs, view);
  const worldmodel = requireWorldmodel();
  const leaf = Mod_PointInLeaf(view, worldmodel);
  const l = worldmodel.leafs.indexOf(leaf) - 1;
  if (l < 0 || !(checkpvs[l >> 3] & (1 << (l & 7)))) {
    c_notvis++;
    RETURN_EDICT(sv.edicts[0]);
    return;
  }

  // might be able to see it
  c_invis++;
  RETURN_EDICT(ent);
}

//============================================================================

/*
=================
PF_stuffcmd

Sends text over to the client's execution buffer

stuffcmd (clientent, value)
=================
*/
function PF_stuffcmd(): void {
  const entnum = G_EDICTNUM(OFS_PARM0);
  if (entnum < 1 || entnum > MAX_CLIENTS) PR_RunError("Parm 0 not a client");
  const str = G_STRING(OFS_PARM1);

  const cl = svs.clients[entnum - 1];

  if (str === "disconnect\n") {
    // so long and thanks for all the fish
    cl.drop = true;
    return;
  }

  ClientReliableWrite_Begin(cl, SvcOpsT.svc_stufftext, 2 + str.length);
  ClientReliableWrite_String(cl, str);
}

/*
=================
PF_localcmd

Sends text over to the client's execution buffer

localcmd (string)
=================
*/
function PF_localcmd(): void {
  const str = G_STRING(OFS_PARM0);
  Cbuf_AddText(str);
}

/*
=================
PF_cvar

float cvar (string)
=================
*/
function PF_cvar(): void {
  const str = G_STRING(OFS_PARM0);
  globals().f[OFS_RETURN] = Cvar_VariableValue(str);
}

/*
=================
PF_cvar_set

float cvar (string)
=================
*/
function PF_cvar_set(): void {
  const varName = G_STRING(OFS_PARM0);
  const val = G_STRING(OFS_PARM1);
  Cvar_Set(varName, val);
}

/*
=================
PF_findradius

Returns a chain of entities that have origins within a spherical area

findradius (origin, radius)
=================
*/
function PF_findradius(): void {
  let chain: QwEdictT = sv.edicts[0];

  const org = G_VECTOR(OFS_PARM0);
  const rad = G_FLOAT(OFS_PARM1);

  const eorg = vec3();
  for (let i = 1; i < sv.num_edicts; i++) {
    const ent = EDICT_NUM(i);
    if (ent.free) continue;
    if (ent.v.solid === SOLID_NOT) continue;
    for (let j = 0; j < 3; j++) eorg[j] = org[j] - (ent.v.origin[j] + (ent.v.mins[j] + ent.v.maxs[j]) * 0.5);
    if (Length(eorg) > rad) continue;

    ent.v.chain = EDICT_TO_PROG(chain);
    chain = ent;
  }

  RETURN_EDICT(chain);
}

/*
=========
PF_dprint
=========
*/
function PF_dprint(): void {
  // QW calls Con_Printf here, not Con_DPrintf -- see file header
  Con_Printf("%s", PF_VarString(0));
}

// char pr_string_temp[128]; (pr_cmds.c:806) -- ONE buffer shared by PF_ftos and
// PF_vtos. PR_SetString dedups by pointer (pr_exec.c:684), so it costs a single
// pr_strtbl slot for the life of the server and two results held at once both
// read whatever the later call wrote, which is what QuakeC was written against.
const pr_string_temp = { value: "" };

function PR_StringTemp(): StringT {
  return PR_SetStringRef(pr_string_temp, () => pr_string_temp.value);
}

function PF_ftos(): void {
  const v = G_FLOAT(OFS_PARM0);
  if (v === Math.trunc(v)) pr_string_temp.value = Com_sprintf("%d", Math.trunc(v));
  else pr_string_temp.value = Com_sprintf("%5.1f", v);
  globals().i[OFS_RETURN] = PR_StringTemp();
}

function PF_fabs(): void {
  globals().f[OFS_RETURN] = Math.abs(G_FLOAT(OFS_PARM0));
}

function PF_vtos(): void {
  const v = G_VECTOR(OFS_PARM0);
  pr_string_temp.value = Com_sprintf("'%5.1f %5.1f %5.1f'", v[0], v[1], v[2]);
  globals().i[OFS_RETURN] = PR_StringTemp();
}

function PF_Spawn(): void {
  const ed = ED_Alloc();
  RETURN_EDICT(ed);
}

function PF_Remove(): void {
  const ed = G_EDICT(OFS_PARM0);
  ED_Free(ed);
}

// entity (entity start, .string field, string match) find = #18;
//
// See src/progs/pr_cmds.ts's identical PF_Find deviation note: the C's
// `if (!s) PR_RunError(...)` and the loop's `if (!t) continue;` both test a
// `char *` that is never NULL (offset 0 is the empty string at
// pr_strings[0]), so both are dead code in the real engine -- an unset
// `.target`/etc. field resolves to "" and is compared like any other value.
// This port's G_STRING/E_STRING (progs.ts) share that never-null property,
// so both checks are dropped rather than ported as JS truthiness, which
// would incorrectly fire on "" (the D.md-reported "PF_Find: bad search
// string" defect on func_train_find's `find(world, targetname, "")` call in
// plats.qc).
function PF_Find(): void {
  let e = G_EDICTNUM(OFS_PARM0);
  const f = G_INT(OFS_PARM1);
  const s = G_STRING(OFS_PARM2);

  for (e++; e < sv.num_edicts; e++) {
    const ed = EDICT_NUM(e);
    if (ed.free) continue;
    const t = E_STRING(ed, f);
    if (t === s) {
      RETURN_EDICT(ed);
      return;
    }
  }

  RETURN_EDICT(sv.edicts[0]);
}

function PR_CheckEmptyString(s: string): void {
  if (s.length === 0 || s.charCodeAt(0) <= 32) PR_RunError("Bad string");
}

function PF_precache_file(): void {
  // precache_file is only used to copy files with qcc, it does nothing
  globals().i[OFS_RETURN] = G_INT(OFS_PARM0);
}

function PF_precache_sound(): void {
  if (sv.state !== ServerStateT.ss_loading) PR_RunError("PF_Precache_*: Precache can only be done in spawn functions");

  const s = G_STRING(OFS_PARM0);
  globals().i[OFS_RETURN] = G_INT(OFS_PARM0);
  PR_CheckEmptyString(s);

  for (let i = 0; i < MAX_SOUNDS; i++) {
    if (sv.sound_precache[i] === null) {
      sv.sound_precache[i] = s;
      return;
    }
    if (sv.sound_precache[i] === s) return;
  }
  PR_RunError("PF_precache_sound: overflow");
}

function PF_precache_model(): void {
  if (sv.state !== ServerStateT.ss_loading) PR_RunError("PF_Precache_*: Precache can only be done in spawn functions");

  const s = G_STRING(OFS_PARM0);
  globals().i[OFS_RETURN] = G_INT(OFS_PARM0);
  PR_CheckEmptyString(s);

  for (let i = 0; i < MAX_MODELS; i++) {
    if (sv.model_precache[i] === null) {
      sv.model_precache[i] = s;
      return;
    }
    if (sv.model_precache[i] === s) return;
  }
  PR_RunError("PF_precache_model: overflow");
}

function PF_coredump(): void {
  ED_PrintEdicts();
}

function PF_traceon(): void {
  prExec.trace = true;
}

function PF_traceoff(): void {
  prExec.trace = false;
}

function PF_eprint(): void {
  ED_PrintNum(G_EDICTNUM(OFS_PARM0));
}

/*
===============
PF_walkmove

float(float yaw, float dist) walkmove
===============
*/
function PF_walkmove(): void {
  const gs = requireGlobalStruct();
  const ent = PROG_TO_EDICT(gs.self);
  let yaw = G_FLOAT(OFS_PARM0);
  const dist = G_FLOAT(OFS_PARM1);

  if (!((ent.v.flags | 0) & (FL_ONGROUND | FL_FLY | FL_SWIM))) {
    globals().f[OFS_RETURN] = 0;
    return;
  }

  yaw = (yaw * M_PI * 2) / 360;

  const move = vec3();
  move[0] = Math.cos(yaw) * dist;
  move[1] = Math.sin(yaw) * dist;
  move[2] = 0;

  // save program state, because SV_movestep may call other progs
  const oldf = prExec.xfunction;
  const oldself = gs.self;

  globals().f[OFS_RETURN] = SV_movestep(ent, move, true) ? 1 : 0;

  // restore program state
  prExec.xfunction = oldf;
  gs.self = oldself;
}

/*
===============
PF_droptofloor

void() droptofloor
===============
*/
function PF_droptofloor(): void {
  const gs = requireGlobalStruct();
  const ent = PROG_TO_EDICT(gs.self);

  const end = vec3();
  VectorCopy(ent.v.origin, end);
  end[2] -= 256;

  const trace = SV_Move(ent.v.origin, ent.v.mins, ent.v.maxs, end, MOVE_NORMAL, ent);

  if (trace.fraction === 1 || trace.allsolid) {
    globals().f[OFS_RETURN] = 0;
  } else {
    VectorCopy(trace.endpos, ent.v.origin);
    SV_LinkEdict(ent, false);
    ent.v.flags = (ent.v.flags | 0) | FL_ONGROUND;
    // trace.ent is unchecked in the C; see file header's deviation note
    if (trace.ent === null) throw new SysError("PF_droptofloor: trace.ent unexpectedly null");
    ent.v.groundentity = EDICT_TO_PROG(trace.ent);
    globals().f[OFS_RETURN] = 1;
  }
}

/*
===============
PF_lightstyle

void(float style, string value) lightstyle
===============
*/
function PF_lightstyle(): void {
  const style = G_FLOAT(OFS_PARM0) | 0;
  const val = G_STRING(OFS_PARM1);

  // change the string in sv
  sv.lightstyles[style] = val;

  // send message to all clients on this server
  if (sv.state !== ServerStateT.ss_active) return;

  for (let j = 0; j < MAX_CLIENTS; j++) {
    const client = svs.clients[j];
    if (client.state === ClientStateT.cs_spawned) {
      ClientReliableWrite_Begin(client, SvcOpsT.svc_lightstyle, val.length + 3);
      ClientReliableWrite_Char(client, style);
      ClientReliableWrite_String(client, val);
    }
  }
}

function PF_rint(): void {
  const f = G_FLOAT(OFS_PARM0);
  globals().f[OFS_RETURN] = f > 0 ? Math.trunc(f + 0.5) : Math.trunc(f - 0.5);
}

function PF_floor(): void {
  globals().f[OFS_RETURN] = Math.floor(G_FLOAT(OFS_PARM0));
}

function PF_ceil(): void {
  globals().f[OFS_RETURN] = Math.ceil(G_FLOAT(OFS_PARM0));
}

/*
=============
PF_checkbottom
=============
*/
function PF_checkbottom(): void {
  const ent = G_EDICT(OFS_PARM0);
  globals().f[OFS_RETURN] = SV_CheckBottom(ent) ? 1 : 0;
}

/*
=============
PF_pointcontents
=============
*/
function PF_pointcontents(): void {
  const v = G_VECTOR(OFS_PARM0);
  globals().f[OFS_RETURN] = SV_PointContents(v);
}

/*
=============
PF_nextent

entity nextent(entity)
=============
*/
function PF_nextent(): void {
  let i = G_EDICTNUM(OFS_PARM0);
  for (;;) {
    i++;
    if (i === sv.num_edicts) {
      RETURN_EDICT(sv.edicts[0]);
      return;
    }
    const ent = EDICT_NUM(i);
    if (!ent.free) {
      RETURN_EDICT(ent);
      return;
    }
  }
}

/*
=============
PF_aim

Pick a vector for the player to shoot along
vector aim(entity, missilespeed)
=============
*/
// see file header: QW's real default is "2"; the old WinQuake-style value
// is kept as a dead comment in the C, ported the same way here.
// const sv_aim = new CvarT("sv_aim", "0.93");
export const sv_aim = new CvarT("sv_aim", "2");

function PF_aim(): void {
  const ent = G_EDICT(OFS_PARM0);

  const start = vec3();
  VectorCopy(ent.v.origin, start);
  start[2] += 20;

  const gs = requireGlobalStruct();

  // noaim option
  const i = NUM_FOR_EDICT(ent);
  if (i > 0 && i < MAX_CLIENTS) {
    const noaim = Info_ValueForKey(svs.clients[i - 1].userinfo, "noaim");
    if (Q_atoi(noaim) > 0) {
      VectorCopy(gs.v_forward, G_VECTOR(OFS_RETURN));
      return;
    }
  }

  // try sending a trace straight
  const dir = vec3();
  VectorCopy(gs.v_forward, dir);
  const end = vec3();
  VectorMA(start, 2048, dir, end);
  let tr = SV_Move(start, vec3_origin, vec3_origin, end, MOVE_NORMAL, ent);
  if (tr.ent && tr.ent.v.takedamage === DAMAGE_AIM && (!teamplay.value || ent.v.team <= 0 || ent.v.team !== tr.ent.v.team)) {
    VectorCopy(gs.v_forward, G_VECTOR(OFS_RETURN));
    return;
  }

  // try all possible entities
  const bestdir = vec3();
  VectorCopy(dir, bestdir);
  let bestdist = sv_aim.value;
  let bestent: QwEdictT | null = null;

  for (let e = 1; e < sv.num_edicts; e++) {
    const check = EDICT_NUM(e);
    if (check.v.takedamage !== DAMAGE_AIM) continue;
    if (check === ent) continue;
    if (teamplay.value && ent.v.team > 0 && ent.v.team === check.v.team) continue; // don't aim at teammate

    for (let j = 0; j < 3; j++) end[j] = check.v.origin[j] + 0.5 * (check.v.mins[j] + check.v.maxs[j]);
    VectorSubtract(end, start, dir);
    VectorNormalize(dir);
    const dist = DotProduct(dir, gs.v_forward);
    if (dist < bestdist) continue; // to far to turn
    tr = SV_Move(start, vec3_origin, vec3_origin, end, MOVE_NORMAL, ent);
    if (tr.ent === check) {
      // can shoot at this one
      bestdist = dist;
      bestent = check;
    }
  }

  if (bestent) {
    VectorSubtract(bestent.v.origin, ent.v.origin, dir);
    const dist = DotProduct(dir, gs.v_forward);
    VectorScale(gs.v_forward, dist, end);
    end[2] = dir[2];
    VectorNormalize(end);
    VectorCopy(end, G_VECTOR(OFS_RETURN));
  } else {
    VectorCopy(bestdir, G_VECTOR(OFS_RETURN));
  }
}

/*
==============
PF_changeyaw

This was a major timewaster in progs, so it was converted to C
==============
*/
export function PF_changeyaw(): void {
  const gs = requireGlobalStruct();
  const ent = PROG_TO_EDICT(gs.self);
  const current = anglemod(ent.v.angles[1]);
  const ideal = ent.v.ideal_yaw;
  const speed = ent.v.yaw_speed;

  if (current === ideal) return;
  let move = ideal - current;
  if (ideal > current) {
    if (move >= 180) move -= 360;
  } else {
    if (move <= -180) move += 360;
  }
  if (move > 0) {
    if (move > speed) move = speed;
  } else {
    if (move < -speed) move = -speed;
  }

  ent.v.angles[1] = anglemod(current + move);
}

/*
===============================================================================

MESSAGE WRITING

===============================================================================
*/

export const MSG_BROADCAST = 0; // unreliable to all
export const MSG_ONE = 1; // reliable to one (msg_entity)
export const MSG_ALL = 2; // reliable to all
export const MSG_INIT = 3; // write to the init string
export const MSG_MULTICAST = 4; // for multicast()

function WriteDest(): SizeBuf {
  const dest = G_FLOAT(OFS_PARM0) | 0;
  switch (dest) {
    case MSG_BROADCAST:
      return sv.datagram;

    case MSG_ONE:
      // dead in the C itself: SV_Error never returns, and the `#if 0`
      // body that follows it is dropped, per PORTING.md's #if 0 rule --
      // see file header.
      SV_Error("Shouldn't be at MSG_ONE");

    case MSG_ALL:
      return sv.reliable_datagram;

    case MSG_INIT:
      if (sv.state !== ServerStateT.ss_loading) PR_RunError("PF_Write_*: MSG_INIT can only be written in spawn functions");
      return sv.signon;

    case MSG_MULTICAST:
      return sv.multicast;

    default:
      PR_RunError("WriteDest: bad destination");
  }
}

function Write_GetClient(): ClientT {
  const ent = PROG_TO_EDICT(requireGlobalStruct().msg_entity);
  const entnum = NUM_FOR_EDICT(ent);
  if (entnum < 1 || entnum > MAX_CLIENTS) PR_RunError("WriteDest: not a client");
  return svs.clients[entnum - 1];
}

function PF_WriteByte(): void {
  if ((G_FLOAT(OFS_PARM0) | 0) === MSG_ONE) {
    const cl = Write_GetClient();
    ClientReliableCheckBlock(cl, 1);
    ClientReliableWrite_Byte(cl, G_FLOAT(OFS_PARM1));
  } else {
    MSG_WriteByte(WriteDest(), G_FLOAT(OFS_PARM1));
  }
}

function PF_WriteChar(): void {
  if ((G_FLOAT(OFS_PARM0) | 0) === MSG_ONE) {
    const cl = Write_GetClient();
    ClientReliableCheckBlock(cl, 1);
    ClientReliableWrite_Char(cl, G_FLOAT(OFS_PARM1));
  } else {
    MSG_WriteChar(WriteDest(), G_FLOAT(OFS_PARM1));
  }
}

function PF_WriteShort(): void {
  if ((G_FLOAT(OFS_PARM0) | 0) === MSG_ONE) {
    const cl = Write_GetClient();
    ClientReliableCheckBlock(cl, 2);
    ClientReliableWrite_Short(cl, G_FLOAT(OFS_PARM1));
  } else {
    MSG_WriteShort(WriteDest(), G_FLOAT(OFS_PARM1));
  }
}

function PF_WriteLong(): void {
  if ((G_FLOAT(OFS_PARM0) | 0) === MSG_ONE) {
    const cl = Write_GetClient();
    ClientReliableCheckBlock(cl, 4);
    ClientReliableWrite_Long(cl, G_FLOAT(OFS_PARM1));
  } else {
    MSG_WriteLong(WriteDest(), G_FLOAT(OFS_PARM1));
  }
}

function PF_WriteAngle(): void {
  if ((G_FLOAT(OFS_PARM0) | 0) === MSG_ONE) {
    const cl = Write_GetClient();
    ClientReliableCheckBlock(cl, 1);
    ClientReliableWrite_Angle(cl, G_FLOAT(OFS_PARM1));
  } else {
    MSG_WriteAngle(WriteDest(), G_FLOAT(OFS_PARM1));
  }
}

function PF_WriteCoord(): void {
  if ((G_FLOAT(OFS_PARM0) | 0) === MSG_ONE) {
    const cl = Write_GetClient();
    ClientReliableCheckBlock(cl, 2);
    ClientReliableWrite_Coord(cl, G_FLOAT(OFS_PARM1));
  } else {
    MSG_WriteCoord(WriteDest(), G_FLOAT(OFS_PARM1));
  }
}

function PF_WriteString(): void {
  if ((G_FLOAT(OFS_PARM0) | 0) === MSG_ONE) {
    const cl = Write_GetClient();
    const s = G_STRING(OFS_PARM1);
    ClientReliableCheckBlock(cl, 1 + s.length);
    ClientReliableWrite_String(cl, s);
  } else {
    MSG_WriteString(WriteDest(), G_STRING(OFS_PARM1));
  }
}

function PF_WriteEntity(): void {
  if ((G_FLOAT(OFS_PARM0) | 0) === MSG_ONE) {
    const cl = Write_GetClient();
    ClientReliableCheckBlock(cl, 2);
    ClientReliableWrite_Short(cl, G_EDICTNUM(OFS_PARM1));
  } else {
    MSG_WriteShort(WriteDest(), G_EDICTNUM(OFS_PARM1));
  }
}

//=============================================================================

function PF_makestatic(): void {
  const ent = G_EDICT(OFS_PARM0);

  MSG_WriteByte(sv.signon, SvcOpsT.svc_spawnstatic);

  MSG_WriteByte(sv.signon, SV_ModelIndex(PR_GetString(ent.v.model)));

  MSG_WriteByte(sv.signon, ent.v.frame);
  MSG_WriteByte(sv.signon, ent.v.colormap);
  MSG_WriteByte(sv.signon, ent.v.skin);
  for (let i = 0; i < 3; i++) {
    MSG_WriteCoord(sv.signon, ent.v.origin[i]);
    MSG_WriteAngle(sv.signon, ent.v.angles[i]);
  }

  // throw the entity away now
  ED_Free(ent);
}

//=============================================================================

/*
==============
PF_setspawnparms
==============
*/
function PF_setspawnparms(): void {
  const ent = G_EDICT(OFS_PARM0);
  const i = NUM_FOR_EDICT(ent);
  if (i < 1 || i > MAX_CLIENTS) PR_RunError("Entity is not a client");

  // copy spawn parms out of the client_t
  const client = svs.clients[i - 1];

  // (&pr_global_struct->parm1)[i] -- see src/progs/pr_cmds.ts's identical deviation note
  const g = globals();
  for (let p = 0; p < NUM_SPAWN_PARMS; p++) {
    g.f[QW_GLOBAL_OFS.parm1 + p] = client.spawn_parms[p];
  }
}

/*
==============
PF_changelevel
==============
*/
let last_spawncount = 0; // static int last_spawncount

function PF_changelevel(): void {
  // make sure we don't issue two changelevels
  if (svs.spawncount === last_spawncount) return;
  last_spawncount = svs.spawncount;

  const s = G_STRING(OFS_PARM0);
  Cbuf_AddText(`map ${s}\n`);
}

/*
==============
PF_logfrag

logfrag (killer, killee)
==============
*/
function PF_logfrag(): void {
  const ent1 = G_EDICT(OFS_PARM0);
  const ent2 = G_EDICT(OFS_PARM1);

  const e1 = NUM_FOR_EDICT(ent1);
  const e2 = NUM_FOR_EDICT(ent2);

  if (e1 < 1 || e1 > MAX_CLIENTS || e2 < 1 || e2 > MAX_CLIENTS) return;

  const s = `\\${svs.clients[e1 - 1].name}\\${svs.clients[e2 - 1].name}\\\n`;

  SZ_Print(svs.log[svs.logsequence & 1], s);
  if (svSendFileState.sv_fraglogfile !== null) {
    const bytes = stringToLatin1Bytes(s);
    Sys_FileWrite(svSendFileState.sv_fraglogfile, bytes, bytes.length);
  }
}

/*
==============
PF_infokey

string(entity e, string key) infokey
==============
*/
// static char ov[256]; (pr_cmds.c:1555) -- PF_infokey's own buffer, holding
// both the "ip" and the "ping" answer. PR_SetString dedups by pointer, so the
// two branches share one pr_strtbl slot for the life of the server and a
// QuakeC-held result changes when the next ip/ping query rewrites the buffer.
const pf_infokey_ov = { value: "" };

function PF_infokey(): void {
  const e = G_EDICT(OFS_PARM0);
  const e1 = NUM_FOR_EDICT(e);
  const key = G_STRING(OFS_PARM1);

  let value: StringT;
  if (e1 === 0) {
    let v = Info_ValueForKey(svs.info, key);
    if (v === "") v = Info_ValueForKey(localinfoState.value, key);
    value = PR_SetString(v);
  } else if (e1 <= MAX_CLIENTS) {
    if (key === "ip") {
      pf_infokey_ov.value = NET_BaseAdrToString(svs.clients[e1 - 1].netchan.remote_address);
      value = PR_SetStringRef(pf_infokey_ov, () => pf_infokey_ov.value);
    } else if (key === "ping") {
      const ping = SV_CalcPing(svs.clients[e1 - 1]);
      pf_infokey_ov.value = Com_sprintf("%d", ping);
      value = PR_SetStringRef(pf_infokey_ov, () => pf_infokey_ov.value);
    } else {
      value = PR_SetString(Info_ValueForKey(svs.clients[e1 - 1].userinfo, key));
    }
  } else {
    value = PR_SetString("");
  }

  globals().i[OFS_RETURN] = value; // RETURN_STRING takes the pointer, not the contents
}

/*
==============
PF_stof

float(string s) stof
==============
*/
function PF_stof(): void {
  const s = G_STRING(OFS_PARM0);
  globals().f[OFS_RETURN] = Q_atof(s);
}

/*
==============
PF_multicast

void(vector where, float set) multicast
==============
*/
function PF_multicast(): void {
  const o = G_VECTOR(OFS_PARM0);
  const to = G_FLOAT(OFS_PARM1) | 0;

  SV_Multicast(o, to);
}

function PF_Fixme(): void {
  PR_RunError("unimplemented bulitin"); // sic: the C's own typo
}

export const pr_builtin: BuiltinT[] = [
  PF_Fixme,
  PF_makevectors, // void(entity e)	makevectors 		= #1;
  PF_setorigin, // void(entity e, vector o) setorigin	= #2;
  PF_setmodel, // void(entity e, string m) setmodel	= #3;
  PF_setsize, // void(entity e, vector min, vector max) setsize = #4;
  PF_Fixme, // void(entity e, vector min, vector max) setabssize = #5;
  PF_break, // void() break						= #6;
  PF_random, // float() random						= #7;
  PF_sound, // void(entity e, float chan, string samp) sound = #8;
  PF_normalize, // vector(vector v) normalize			= #9;
  PF_error, // void(string e) error				= #10;
  PF_objerror, // void(string e) objerror				= #11;
  PF_vlen, // float(vector v) vlen				= #12;
  PF_vectoyaw, // float(vector v) vectoyaw		= #13;
  PF_Spawn, // entity() spawn						= #14;
  PF_Remove, // void(entity e) remove				= #15;
  PF_traceline, // float(vector v1, vector v2, float tryents) traceline = #16;
  PF_checkclient, // entity() clientlist					= #17;
  PF_Find, // entity(entity start, .string fld, string match) find = #18;
  PF_precache_sound, // void(string s) precache_sound		= #19;
  PF_precache_model, // void(string s) precache_model		= #20;
  PF_stuffcmd, // void(entity client, string s)stuffcmd = #21;
  PF_findradius, // entity(vector org, float rad) findradius = #22;
  PF_bprint, // void(string s) bprint				= #23;
  PF_sprint, // void(entity client, string s) sprint = #24;
  PF_dprint, // void(string s) dprint				= #25;
  PF_ftos, // void(string s) ftos				= #26;
  PF_vtos, // void(string s) vtos				= #27;
  PF_coredump,
  PF_traceon,
  PF_traceoff,
  PF_eprint, // void(entity e) debug print an entire entity
  PF_walkmove, // float(float yaw, float dist) walkmove
  PF_Fixme, // float(float yaw, float dist) walkmove
  PF_droptofloor,
  PF_lightstyle,
  PF_rint,
  PF_floor,
  PF_ceil,
  PF_Fixme,
  PF_checkbottom,
  PF_pointcontents,
  PF_Fixme,
  PF_fabs,
  PF_aim,
  PF_cvar,
  PF_localcmd,
  PF_nextent,
  PF_Fixme, // WinQuake's #46 is PF_particle, gone entirely in QW -- see file header
  PF_changeyaw,
  PF_Fixme,
  PF_vectoangles,

  PF_WriteByte,
  PF_WriteChar,
  PF_WriteShort,
  PF_WriteLong,
  PF_WriteCoord,
  PF_WriteAngle,
  PF_WriteString,
  PF_WriteEntity,

  // #ifdef QUAKE2's PF_sin/PF_cos/PF_sqrt/PF_changepitch/PF_TraceToss/
  // PF_etos/PF_WaterMove dropped -- never defined in a QW build either.
  PF_Fixme,
  PF_Fixme,
  PF_Fixme,
  PF_Fixme,
  PF_Fixme,
  PF_Fixme,
  PF_Fixme,

  SV_MoveToGoal,
  PF_precache_file,
  PF_makestatic,

  PF_changelevel,
  PF_Fixme,

  PF_cvar_set,
  PF_centerprint,

  PF_ambientsound,

  PF_precache_model,
  PF_precache_sound, // precache_sound2 is different only for qcc
  PF_precache_file,

  PF_setspawnparms,

  PF_logfrag,

  PF_infokey,
  PF_stof,
  PF_multicast,
];

export const pr_numbuiltins = pr_builtin.length;

setBuiltins(pr_builtin); // pr_builtins = pr_builtin; pr_numbuiltins = sizeof(...)/... -- see file header
