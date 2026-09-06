/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/pr_cmds.c (GNU GPL v2 or later).

The QuakeC builtin functions (`PF_*`) and the `pr_builtin[]` dispatch table
`OP_CALL*` reaches through `pr_exec.ts`'s negative-`first_statement`
convention. Every builtin keeps its C name; the table keeps the C's exact
slot order, with `PF_Fixme` (`PR_RunError ("unimplemented bulitin")`, the
C's own typo kept) filling every gap the C leaves via `#ifdef QUAKE2`/unused
slots.

Deviations from the C source:
- `pr_builtins`/`pr_numbuiltins` are pr_exec.ts's (U022) exported holder;
  this module hands its table over via `setBuiltins(pr_builtin)` at module
  load time (ruling from the unit brief), matching pr_exec.ts's own file
  header, which already documents expecting this. `pr_numbuiltins` is
  `pr_builtin.length`.
- `PF_VarString`'s C `static char out[256]` truncation never bites in
  practice (no QuakeC caller loops enough OFS_PARM* to exceed 256 bytes) and
  has no meaningful TS equivalent over a JS string; ported as unbounded
  string concatenation.
- `PF_error`/`PF_objerror` read `pr_strings + pr_xfunction->s_name` --
  `pr_xfunction` unchecked. It is only ever null before the first
  `PR_ExecuteProgram` call, which cannot happen while a builtin is running
  through the VM, but pr_cmds.test.ts drives builtins directly without going
  through `PR_ExecuteProgram`, so this port guards it (`xfunctionName()`
  below) instead of segfaulting.
- `PF_break`'s `*(int *)-4 = 0; // dump to debugger` has no TS equivalent
  (there is no debugger trap to force); ported as a no-op after the
  `Con_Printf`, matching the C's own commented-out `PR_RunError` alternative
  in spirit -- the statement is dropped, not replaced.
- `PF_random`'s `rand()` (mathlib.ts owns `rand`/`random` per PORTING.md's
  general idiom map, but the unit brief rules this builtin's `rand()` call
  is local to this file): `Math.floor(Math.random() * 0x8000) & 0x7fff`,
  reported per the brief's explicit ruling.
- `PF_setmodel`: the actual pr_cmds.c body read for this port has no
  `mod->type == mod_brush` branch (unlike the unit brief's RULINGS
  paraphrase) -- it always calls `SetMinMaxSize (e, mod->mins, mod->maxs,
  true)` when `sv.models[i]` is non-null, regardless of model type. Ported
  literally from the source file rather than the brief's paraphrase.
  `e->v.model = m - pr_strings` (a pointer difference into the *progs*
  string block) has no TS equivalent since `sv.model_precache` here holds
  resolved string *content*, not `pr_strings` offsets; ruling (unit brief):
  store the same `string_t` the parameter carried, i.e. `G_INT(OFS_PARM1)`,
  verbatim into `e.v.model`, rather than resolving a fresh engine string.
- `SetMinMaxSize`'s C body sets `rotate = false; // FIXME: implement
  rotation properly again` unconditionally, so the `if (angles...)` rotated
  bounding-box branch is live code but permanently unreachable (not an
  `#if 0` -- the C really compiles and carries it, it just never runs). This
  port keeps both branches for the same reason PORTING.md asks for
  exact fidelity; the `rotate` C parameter is renamed `rotateArg` here
  purely because a second local named `rotate` (the always-false override)
  shadows it, and is otherwise unused, exactly as in the C.
- `PF_checkclient`/`PF_newcheckclient`'s `checkpvs[MAX_MAP_LEAFS/8]` is a
  module-private `Uint8Array`, per the unit brief's ruling.
  `leaf - sv.worldmodel->leafs` (a pointer difference) becomes
  `worldmodel.leafs.indexOf(leaf)`, the same substitution world.ts's
  `SV_FindTouchedLeafs` already uses for the identical C idiom.
- `PF_stuffcmd` reassigns `host_client` around `Host_ClientCommands` through
  `svState.host_client` (server.ts's exported reassignable-global holder),
  per PORTING.md's ruling for that C global.
- `PF_bprint`'s `SV_BroadcastPrintf` lives in host.c (U035), which is not
  landed beyond the placeholder in src/common/host.ts (which does not
  export it). Its body (`sv_main.c`'s definition, actually host.c's) is
  inlined here directly: walk `svs.clients`, write `svc_print` + the string
  to every active, spawned client's message buffer. When host.ts lands the
  real `SV_BroadcastPrintf`, the coordinator should point `PF_bprint` at it
  instead of this inlined copy.
- `PF_setspawnparms`'s `(&pr_global_struct->parm1)[i]` (pointer arithmetic
  over contiguous `parm1..parm16` floats) has no equivalent through
  `GlobalVars`, which exposes them only as individually named
  getters/setters. Ported as a direct write into the shared float view at
  `GLOBAL_OFS.parm1 + i`, which is the same contiguous layout the C's
  pointer walk relies on.
- `PF_precache_file`/`PF_precache_sound`/`PF_precache_model` reuse the same
  function pointer at two table slots each (#19/#76, #20/#75, #68/#77 in the
  C); ported as the same function referenced twice in `pr_builtin`, exactly
  as the C's array literal does.
- `sv_aim` (`cvar_t sv_aim = {"sv_aim", "0.93"};`) is defined here; its only
  registration site is `SV_Init` in sv_main.ts, as in the C.
- `PF_droptofloor`'s `ent->v.groundentity = EDICT_TO_PROG(trace.ent)` derefs
  `trace.ent` unchecked; this port only reaches that line when
  `trace.fraction < 1` (the `else` of the `fraction==1||allsolid` guard),
  which SV_ClipMoveToEntity/SV_ClipToLinks (world.ts) guarantee sets
  `trace.ent` whenever `fraction < 1`, so a `SysError` guard replaces the
  unchecked dereference rather than ever firing in practice.
- `PF_makestatic`'s `SV_ModelIndex`, `PF_sound`'s/`PF_particle`'s
  `SV_StartSound`/`SV_StartParticle` come from sv_main.ts (concurrent, not
  yet landed as of this unit); `PF_walkmove`'s `SV_movestep`,
  `PF_checkbottom`'s `SV_CheckBottom`, and `pr_builtin[67]`'s
  `SV_MoveToGoal` come from sv_move.ts (same). Per the unit brief, the only
  acceptable `bun run check` failures from this file are
  "Cannot find module '../server/sv_main'" / "'../server/sv_move'" and
  errors on the missing names.
- `PF_Find`'s `if (!s) PR_RunError(...)`/`if (!t) continue;` (bug fix,
  2026-09-05, D.md Defect B): both test a `char *` that is never NULL in the
  C (offset 0 is the empty string at `pr_strings[0]`), so both are dead code
  in the real engine and are dropped here rather than ported as JS
  truthiness, which fired on an empty (unset) `.target`/etc. field and threw
  "PF_Find: bad search string" on `changelevel dm2` (func_train_find's
  `find(world, targetname, self.target)` in plats.qc, `self.target` unset).
  See PF_Find's own comment for the full reasoning.
*/

import { SV_BroadcastPrintf } from "../common/host";
import { MAX_MAP_LEAFS } from "../common/bspfile";
import { Con_DPrintf, Con_Printf } from "../client/console";
import { Cbuf_AddText } from "../common/cmd";
import { Com_sprintf } from "../common/sprintf";
import { CvarT, Cvar_RegisterVariable, Cvar_Set, Cvar_VariableValue } from "../common/cvar";
import { Host_ClientCommands, Host_Error, teamplay } from "../common/host";
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
} from "../common/mathlib";
import { Mod_ForName, Mod_LeafPVS, Mod_PointInLeaf, type ModelT } from "../common/model";
import { MAX_MODELS, MAX_SOUNDS } from "../common/quakedef";
import { MSG_WriteAngle, MSG_WriteByte, MSG_WriteChar, MSG_WriteCoord, MSG_WriteLong, MSG_WriteShort, MSG_WriteString, type SizeBuf } from "../common/sizebuf";
import { SvcOpsT } from "../common/protocol";
import { Sys_Error, SysError } from "../platform/sys";
import { GLOBAL_OFS, type GlobalVars } from "./progdefs";
import {
  EDICT_NUM,
  EDICT_TO_PROG,
  EdictT,
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
  PR_SetEngineStringRef,
  RETURN_EDICT,
  pr,
} from "./progs";
import { ED_Alloc, ED_Free, ED_Print, ED_PrintEdicts, ED_PrintNum } from "./pr_edict";
import { OFS_PARM0, OFS_PARM1, OFS_PARM2, OFS_PARM3, OFS_PARM4, OFS_RETURN, type StringT } from "./pr_comp";
import { PR_RunError, prExec, setBuiltins, type BuiltinT } from "./pr_exec";
import {
  DAMAGE_AIM,
  FL_FLY,
  FL_NOTARGET,
  FL_ONGROUND,
  FL_SWIM,
  ServerStateT,
  SOLID_NOT,
  svState,
  sv,
  svs,
  NUM_SPAWN_PARMS,
} from "../server/server";
import { MOVE_NORMAL, SV_LinkEdict, SV_Move, SV_PointContents } from "../server/world";
import { SV_CheckBottom, SV_MoveToGoal, SV_movestep } from "../server/sv_move";
import { SV_ModelIndex, SV_StartParticle, SV_StartSound } from "../server/sv_main";

//============================================================================
// small module-private guards, matching the pattern already established in
// progs.ts/pr_exec.ts/pr_edict.ts/world.ts (each file keeps its own copy
// rather than sharing one, since none of theirs are exported).

function globals(): { f: Float32Array; i: Int32Array } {
  if (pr.globals === null) throw new SysError("pr_cmds.ts: pr.globals not set (PR_LoadProgs not called)");
  return pr.globals;
}

function requireGlobalStruct(): GlobalVars {
  if (pr.global_struct === null) throw new SysError("pr_cmds.ts: pr.global_struct not set (PR_LoadProgs not called)");
  return pr.global_struct;
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

  Host_Error("Program error");
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

  Host_Error("Program error");
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

// see file header's SetMinMaxSize deviation note
function SetMinMaxSize(e: EdictT, min: Vec3, max: Vec3, rotateArg: boolean): void {
  for (let i = 0; i < 3; i++) {
    if (min[i] > max[i]) PR_RunError("backwards mins/maxs");
  }

  const rotate = false; // FIXME: implement rotation properly again
  void rotateArg; // the C's own passed-in flag, equally unused after the override above

  const rmin = vec3();
  const rmax = vec3();

  if (!rotate) {
    VectorCopy(min, rmin);
    VectorCopy(max, rmax);
  } else {
    // find min / max for rotations
    const angles = e.v.angles;
    const a = (angles[1] / 180) * M_PI;

    const xvector = [Math.cos(a), Math.sin(a)];
    const yvector = [-Math.sin(a), Math.cos(a)];

    const bounds: [Vec3, Vec3] = [vec3(), vec3()];
    VectorCopy(min, bounds[0]);
    VectorCopy(max, bounds[1]);

    rmin[0] = rmin[1] = rmin[2] = 9999;
    rmax[0] = rmax[1] = rmax[2] = -9999;

    const base = vec3();
    const transformed = vec3();

    for (let i = 0; i <= 1; i++) {
      base[0] = bounds[i][0];
      for (let j = 0; j <= 1; j++) {
        base[1] = bounds[j][1];
        for (let k = 0; k <= 1; k++) {
          base[2] = bounds[k][2];

          // transform the point
          transformed[0] = xvector[0] * base[0] + yvector[0] * base[1];
          transformed[1] = xvector[1] * base[0] + yvector[1] * base[1];
          transformed[2] = base[2];

          for (let l = 0; l < 3; l++) {
            if (transformed[l] < rmin[l]) rmin[l] = transformed[l];
            if (transformed[l] > rmax[l]) rmax[l] = transformed[l];
          }
        }
      }
    }
  }

  // set derived values
  VectorCopy(rmin, e.v.mins);
  VectorCopy(rmax, e.v.maxs);
  VectorSubtract(max, min, e.v.size);

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
  SetMinMaxSize(e, min, max, false);
}

/*
=================
PF_setmodel

setmodel(entity, model)
=================
*/
function PF_setmodel(): void {
  const e = G_EDICT(OFS_PARM0);
  const parm = G_INT(OFS_PARM1); // the parameter's own string_t, kept for e.v.model (see file header)
  const m = PR_GetString(parm);

  // check to see if model was properly precached
  let i = 0;
  while (sv.model_precache[i] !== null && sv.model_precache[i] !== m) i++;

  if (sv.model_precache[i] === null) PR_RunError("no precache: %s\n", m);

  e.v.model = parm;
  e.v.modelindex = i;

  const mod = sv.models[i];

  if (mod) SetMinMaxSize(e, mod.mins, mod.maxs, true);
  else SetMinMaxSize(e, vec3_origin, vec3_origin, true);
}

/*
=================
PF_bprint

broadcast print to everyone on server

bprint(value)
=================
*/
function PF_bprint(): void {
  const s = PF_VarString(0);
  SV_BroadcastPrintf("%s", s);
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
  const s = PF_VarString(1);

  if (entnum < 1 || entnum > svs.maxclients) {
    Con_Printf("tried to sprint to a non-client\n");
    return;
  }

  const client = svs.clients[entnum - 1];

  MSG_WriteChar(client.message, SvcOpsT.svc_print);
  MSG_WriteString(client.message, s);
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

  if (entnum < 1 || entnum > svs.maxclients) {
    Con_Printf("tried to sprint to a non-client\n");
    return;
  }

  const client = svs.clients[entnum - 1];

  MSG_WriteChar(client.message, SvcOpsT.svc_centerprint);
  MSG_WriteString(client.message, s);
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
  // rand() has no libc equivalent; see file header's ruling
  const num = (Math.floor(Math.random() * 0x8000) & 0x7fff) / 0x7fff;
  globals().f[OFS_RETURN] = num;
}

/*
=================
PF_particle

particle(origin, color, count)
=================
*/
function PF_particle(): void {
  const org = G_VECTOR(OFS_PARM0);
  const dir = G_VECTOR(OFS_PARM1);
  const color = G_FLOAT(OFS_PARM2);
  const count = G_FLOAT(OFS_PARM3);
  SV_StartParticle(org, dir, color, count);
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

  if (volume < 0 || volume > 255) Sys_Error("SV_StartSound: volume = %i", volume);

  if (attenuation < 0 || attenuation > 4) Sys_Error("SV_StartSound: attenuation = %f", attenuation);

  if (channel < 0 || channel > 7) Sys_Error("SV_StartSound: channel = %i", channel);

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
  if (check > svs.maxclients) check = svs.maxclients;

  let i = check === svs.maxclients ? 1 : check + 1;

  let ent: EdictT = EDICT_NUM(i);
  for (;;) {
    if (i === svs.maxclients + 1) i = 1;

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
  if (entnum < 1 || entnum > svs.maxclients) PR_RunError("Parm 0 not a client");
  const str = G_STRING(OFS_PARM1);

  const old = svState.host_client;
  svState.host_client = svs.clients[entnum - 1];
  Host_ClientCommands("%s", str);
  svState.host_client = old;
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
  let chain: EdictT = sv.edicts[0];

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
  Con_DPrintf("%s", PF_VarString(0));
}

// char pr_string_temp[128]; -- ONE buffer shared by PF_ftos and PF_vtos, handed
// to progs as the fixed offset `pr_string_temp - pr_strings`. Two ftos results
// held at once therefore both read whatever the later call wrote, which is the
// behaviour QuakeC was written against.
const pr_string_temp = { value: "" };

function PR_StringTemp(): StringT {
  return PR_SetEngineStringRef(pr_string_temp, () => pr_string_temp.value);
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

// entity (entity start, .string field, string match) find = #5;
// non-QUAKE2 branch (see file header)
//
// The C's `s = G_STRING(OFS_PARM2); if (!s) PR_RunError(...)` and the loop's
// `t = E_STRING(ed,f); if (!t) continue;` both test a `char *` (pr_strings +
// offset), which is never NULL -- offset 0 is the empty string living at
// pr_strings[0], not a null pointer -- so both checks are dead code in the
// real engine: an entity whose `.target` (or whatever field `f` names) is
// unset resolves to "" and is compared by `strcmp` like any other value,
// never short-circuited. This port's G_STRING/E_STRING (progs.ts) have the
// same property -- they always return a string, throwing SysError only for
// a genuinely out-of-range engine-string index, never returning a falsy
// non-string -- so porting `!s`/`!t` literally as JS truthiness would fire
// on "" and diverge from the C (this was the D.md-reported "PF_Find: bad
// search string" defect on func_train_find's `find(world, targetname, "")`
// call in plats.qc). Both checks are dropped, matching the C's actual
// (never-firing) behavior rather than its literal token-for-token text.
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
      sv.models[i] = Mod_ForName(s, true);
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

  for (let j = 0; j < svs.maxclients; j++) {
    const client = svs.clients[j];
    if (client.active || client.spawned) {
      MSG_WriteChar(client.message, SvcOpsT.svc_lightstyle);
      MSG_WriteChar(client.message, style);
      MSG_WriteString(client.message, val);
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
export const sv_aim = new CvarT("sv_aim", "0.93");

function PF_aim(): void {
  const ent = G_EDICT(OFS_PARM0);

  const start = vec3();
  VectorCopy(ent.v.origin, start);
  start[2] += 20;

  const gs = requireGlobalStruct();

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
  let bestent: EdictT | null = null;

  for (let i = 1; i < sv.num_edicts; i++) {
    const check = EDICT_NUM(i);
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

function WriteDest(): SizeBuf {
  const dest = G_FLOAT(OFS_PARM0) | 0;
  switch (dest) {
    case MSG_BROADCAST:
      return sv.datagram;

    case MSG_ONE: {
      const gs = requireGlobalStruct();
      const ent = PROG_TO_EDICT(gs.msg_entity);
      const entnum = NUM_FOR_EDICT(ent);
      if (entnum < 1 || entnum > svs.maxclients) PR_RunError("WriteDest: not a client");
      return svs.clients[entnum - 1].message;
    }

    case MSG_ALL:
      return sv.reliable_datagram;

    case MSG_INIT:
      return sv.signon;

    default:
      PR_RunError("WriteDest: bad destination");
  }
}

function PF_WriteByte(): void {
  MSG_WriteByte(WriteDest(), G_FLOAT(OFS_PARM1));
}

function PF_WriteChar(): void {
  MSG_WriteChar(WriteDest(), G_FLOAT(OFS_PARM1));
}

function PF_WriteShort(): void {
  MSG_WriteShort(WriteDest(), G_FLOAT(OFS_PARM1));
}

function PF_WriteLong(): void {
  MSG_WriteLong(WriteDest(), G_FLOAT(OFS_PARM1));
}

function PF_WriteAngle(): void {
  MSG_WriteAngle(WriteDest(), G_FLOAT(OFS_PARM1));
}

function PF_WriteCoord(): void {
  MSG_WriteCoord(WriteDest(), G_FLOAT(OFS_PARM1));
}

function PF_WriteString(): void {
  MSG_WriteString(WriteDest(), G_STRING(OFS_PARM1));
}

function PF_WriteEntity(): void {
  MSG_WriteShort(WriteDest(), G_EDICTNUM(OFS_PARM1));
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
  if (i < 1 || i > svs.maxclients) PR_RunError("Entity is not a client");

  // copy spawn parms out of the client_t
  const client = svs.clients[i - 1];

  // (&pr_global_struct->parm1)[i] -- see file header's deviation note
  const g = globals();
  for (let p = 0; p < NUM_SPAWN_PARMS; p++) {
    g.f[GLOBAL_OFS.parm1 + p] = client.spawn_parms[p];
  }
}

/*
==============
PF_changelevel
==============
*/
function PF_changelevel(): void {
  // make sure we don't issue two changelevels
  if (svs.changelevel_issued) return;
  svs.changelevel_issued = true;

  const s = G_STRING(OFS_PARM0);
  Cbuf_AddText(`changelevel ${s}\n`);
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
  PF_particle,
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
  // PF_etos/PF_WaterMove dropped -- never defined in a WinQuake build.
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
];

export const pr_numbuiltins = pr_builtin.length;

setBuiltins(pr_builtin); // pr_builtins = pr_builtin; pr_numbuiltins = sizeof(...)/... -- see file header
