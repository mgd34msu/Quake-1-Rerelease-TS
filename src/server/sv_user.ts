/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/sv_user.c (GNU GPL v2 or later).

sv_user.c -- server code for moving users

Deviations from PORTING.md / the C source:
- `edict_t *sv_player` / `client_t *host_client` are the C's reassigned
  globals; per server.ts's own deviation note they are `svState.sv_player` /
  `svState.host_client`, read here through `requireSvPlayer()`/
  `requireHostClient()` guards rather than duplicated.
- The C's `float *angles`, `float *origin`, `float *velocity` are pointers
  reassigned once per SV_ClientThink call (`origin = sv_player->v.origin;
  velocity = sv_player->v.velocity;`) and then read by SV_UserFriction/
  SV_Accelerate/SV_AirMove/SV_WaterMove later in the same call. Since
  `svState.sv_player` never changes between that assignment and every use
  site within one call, re-reading `svState.sv_player.v.origin`/`.velocity`
  at each use (via the local `currentOrigin()`/`currentVelocity()` helpers)
  is behaviorally identical and, as a bonus, lets SV_Accelerate/
  SV_AirAccelerate/SV_UserFriction/SV_AirMove/SV_WaterMove be unit-tested
  directly without first running SV_ClientThink. `angles` is used only
  inside SV_ClientThink itself (for the angles[ROLL]/[PITCH]/[YAW] lines), so
  it stays a local there instead of a module global.
- `#if 0 void SV_Accelerate (vec3_t wishvel) {...} #endif`: dead code, dropped
  per PORTING.md's `#if 0` rule; only the real `SV_Accelerate(void)` below it
  is ported.
- `SV_Move`'s `type` parameter: SV_SetIdealPitch and SV_UserFriction each pass
  the C literal `1` / `(int)true` (not a named MOVE_* constant -- sv_user.c
  predates that naming and just happens to use the same numeric value
  world.ts's MOVE_NOMONSTERS export uses); ported as the literal `1` to avoid
  implying an intent the C source does not carry.
- `V_CalcRoll` (view.c, client-side, not landed) is ported here as a private
  helper per the unit brief's ruling, using its own local forward/right/up
  scratch vectors -- the C's `V_CalcRoll` uses view.c's own file-scope
  `forward, right, up` globals, a completely different pair of statics from
  this file's own `forward, right, up`, so a faithful port must not touch
  this module's own module-scope vectors from inside it. `cl_rollspeed`/
  `cl_rollangle` (view.c's cvars) are read via `Cvar_FindVar`, falling back
  to the ruling's defaults (200 / 2.0) when unregistered -- documented here
  as a deviation for U052 (view.c) to reconcile once it registers the real
  cvars.
- `SV_DropClient` (host.c, U035, not landed) is reached through
  `svMainHooks.dropClient`, the hook object sv_main.ts (U031, concurrent)
  defines, with a `Sys_Error` fallback when no hook is registered. If
  sv_main.ts is not yet landed, this file's only `bun run check` failure is
  `Cannot find module './sv_main'`.
- `sv_friction`/`sv_stopspeed` (sv_phys.c, U032, concurrent) are imported
  from `./sv_phys`. If that module is not yet landed, this file's only
  additional `bun run check` failure is `Cannot find module './sv_phys'`.
- `key_dest == key_game` (keys.c, U048, not landed): `svUserHooks.keyDestIsGame`
  is a registrable hook, `null` until U048 lands. With no hook registered,
  SV_RunClients treats it as `true` (the dedicated-server / dedicated-build
  behavior of never gating on a menu that doesn't exist in this port yet).
- `#ifdef QUAKE2` (the light_level byte SV_ReadClientMove reads) is dropped
  per PORTING.md's dead-`#ifdef` rule (never defined in a WinQuake build).
- `goto nextmsg` (SV_ReadClientMessage) becomes an inner `for(;;)` loop that
  `break`s back to the top of the outer `for(;;)` loop on opcode -1, per
  PORTING.md's "goto -> early return / labelled break" idiom map entry. The
  C's trailing `} while (ret == 1); return true;` is unreachable dead code
  (the only ways out of the inner `while(1)` are `return` or `goto nextmsg`,
  which re-enters the outer loop above the condition check, so the outer
  loop's own condition and the final `return true` after it are never
  actually reached) and is not ported; the `for(;;)` here has the identical
  set of exit points (the two early `return`s inside the outer loop body).
  The opcode-classification local variable is named `cmdOp` here (not `cmd`,
  the C's own name for it) purely to avoid shadowing this module's own
  exported `cmd: UsercmdT` global in the same scope; this is a naming choice,
  not a behavior change.
*/

import { svState, sv, svs, UsercmdT, type ClientT, MOVETYPE_WALK, MOVETYPE_NOCLIP, MOVETYPE_NONE, FL_ONGROUND, FL_WATERJUMP, NUM_PING_TIMES } from "./server";
import { SV_Move } from "./world";
import type { EdictT } from "../progs/progs";
import { host } from "../common/host";
import { CvarT, Cvar_FindVar } from "../common/cvar";
import { type Vec3, vec3, vec3_origin, M_PI, AngleVectors, DotProduct, VectorNormalize, VectorScale, VectorCopy, VectorAdd, Length } from "../common/mathlib";
import { PITCH, YAW, ROLL, ON_EPSILON } from "../common/quakedef";
import { MSG_BeginReading, MSG_ReadChar, MSG_ReadByte, MSG_ReadShort, MSG_ReadFloat, MSG_ReadAngle, MSG_ReadString, msgState } from "../common/sizebuf";
import { NET_GetMessage } from "../common/net_main";
import { ClcOpsT } from "../common/protocol";
import { Cmd_ExecuteString, CmdSourceT, Cbuf_InsertText } from "../common/cmd";
import { Q_strncasecmp } from "../common/common";
import { Con_DPrintf } from "../client/console";
import { Sys_Printf, Sys_Error, SysError } from "../platform/sys";
import { sv_friction, sv_stopspeed } from "./sv_phys";
import { svMainHooks } from "./sv_main";

//============================================================================
// key_dest == key_game (keys.c, U048, not landed) -- see file header.
export const svUserHooks: { keyDestIsGame: (() => boolean) | null } = { keyDestIsGame: null };

//============================================================================

const forward: Vec3 = vec3();
const right: Vec3 = vec3();
const up: Vec3 = vec3();

export const wishdir: Vec3 = vec3();
export let wishspeed = 0;

export let onground = false;

// usercmd_t cmd;
export const cmd = new UsercmdT();

export const sv_edgefriction = new CvarT("edgefriction", "2");
export const sv_idealpitchscale = new CvarT("sv_idealpitchscale", "0.8");
export const sv_maxspeed = new CvarT("sv_maxspeed", "320", false, true);
export const sv_accelerate = new CvarT("sv_accelerate", "10");

function requireSvPlayer(): EdictT {
  if (svState.sv_player === null) throw new SysError("SV_user: svState.sv_player not set");
  return svState.sv_player;
}

function requireHostClient(): ClientT {
  if (svState.host_client === null) throw new SysError("SV_user: svState.host_client not set");
  return svState.host_client;
}

function requireEdict(client: ClientT): EdictT {
  if (client.edict === null) throw new SysError("SV_user: host_client.edict not set");
  return client.edict;
}

// see file header: read-through replacements for the C's cached
// origin/velocity pointers.
function currentOrigin(): Vec3 {
  return requireSvPlayer().v.origin;
}
function currentVelocity(): Vec3 {
  return requireSvPlayer().v.velocity;
}

function copyUsercmd(dst: UsercmdT, src: UsercmdT): void {
  VectorCopy(src.viewangles, dst.viewangles);
  dst.forwardmove = src.forwardmove;
  dst.sidemove = src.sidemove;
  dst.upmove = src.upmove;
}

/*
===============
SV_SetIdealPitch
===============
*/
const MAX_FORWARD = 6;
export function SV_SetIdealPitch(): void {
  const sv_player = requireSvPlayer();

  if (!((sv_player.v.flags | 0) & FL_ONGROUND)) return;

  const angleval = (sv_player.v.angles[YAW] * M_PI * 2) / 360;
  const sinval = Math.sin(angleval);
  const cosval = Math.cos(angleval);

  const z = new Float32Array(MAX_FORWARD);
  let i = 0;
  for (; i < MAX_FORWARD; i++) {
    const top = vec3();
    top[0] = sv_player.v.origin[0] + cosval * (i + 3) * 12;
    top[1] = sv_player.v.origin[1] + sinval * (i + 3) * 12;
    top[2] = sv_player.v.origin[2] + sv_player.v.view_ofs[2];

    const bottom = vec3();
    bottom[0] = top[0];
    bottom[1] = top[1];
    bottom[2] = top[2] - 160;

    const tr = SV_Move(top, vec3_origin, vec3_origin, bottom, 1, sv_player);
    if (tr.allsolid) return; // looking at a wall, leave ideal the way is was

    if (tr.fraction === 1) return; // near a dropoff

    z[i] = top[2] + tr.fraction * (bottom[2] - top[2]);
  }

  let dir = 0;
  let steps = 0;
  for (let j = 1; j < i; j++) {
    const step = z[j] - z[j - 1];
    if (step > -ON_EPSILON && step < ON_EPSILON) continue;

    if (dir && (step - dir > ON_EPSILON || step - dir < -ON_EPSILON)) return; // mixed changes

    steps++;
    dir = step;
  }

  if (!dir) {
    sv_player.v.idealpitch = 0;
    return;
  }

  if (steps < 2) return;
  sv_player.v.idealpitch = -dir * sv_idealpitchscale.value;
}

/*
==================
SV_UserFriction

==================
*/
export function SV_UserFriction(): void {
  const sv_player = requireSvPlayer();
  const vel = currentVelocity();

  const speed = Math.sqrt(vel[0] * vel[0] + vel[1] * vel[1]);
  if (!speed) return;

  // if the leading edge is over a dropoff, increase friction
  const origin = currentOrigin();
  const start = vec3();
  const stop = vec3();
  start[0] = stop[0] = origin[0] + (vel[0] / speed) * 16;
  start[1] = stop[1] = origin[1] + (vel[1] / speed) * 16;
  start[2] = origin[2] + sv_player.v.mins[2];
  stop[2] = start[2] - 34;

  const trace = SV_Move(start, vec3_origin, vec3_origin, stop, 1, sv_player);

  let friction: number;
  if (trace.fraction === 1.0) friction = sv_friction.value * sv_edgefriction.value;
  else friction = sv_friction.value;

  // apply friction
  const control = speed < sv_stopspeed.value ? sv_stopspeed.value : speed;
  let newspeed = speed - host.frametime * control * friction;

  if (newspeed < 0) newspeed = 0;
  newspeed /= speed;

  vel[0] = vel[0] * newspeed;
  vel[1] = vel[1] * newspeed;
  vel[2] = vel[2] * newspeed;
}

/*
==============
SV_Accelerate
==============
*/
export function SV_Accelerate(): void {
  const velocity = currentVelocity();

  const currentspeed = DotProduct(velocity, wishdir);
  const addspeed = wishspeed - currentspeed;
  if (addspeed <= 0) return;
  let accelspeed = sv_accelerate.value * host.frametime * wishspeed;
  if (accelspeed > addspeed) accelspeed = addspeed;

  for (let i = 0; i < 3; i++) velocity[i] += accelspeed * wishdir[i];
}

export function SV_AirAccelerate(wishveloc: Vec3): void {
  const velocity = currentVelocity();

  let wishspd = VectorNormalize(wishveloc);
  if (wishspd > 30) wishspd = 30;
  const currentspeed = DotProduct(velocity, wishveloc);
  const addspeed = wishspd - currentspeed;
  if (addspeed <= 0) return;
  //	accelspeed = sv_accelerate.value * host_frametime;
  let accelspeed = sv_accelerate.value * wishspeed * host.frametime; // note: the C's own `wishspeed` here is this module's global, not the local `wishspd` -- kept exactly as the C has it
  if (accelspeed > addspeed) accelspeed = addspeed;

  for (let i = 0; i < 3; i++) velocity[i] += accelspeed * wishveloc[i];
}

export function DropPunchAngle(): void {
  const sv_player = requireSvPlayer();

  let len = VectorNormalize(sv_player.v.punchangle);

  len -= 10 * host.frametime;
  if (len < 0) len = 0;
  VectorScale(sv_player.v.punchangle, len, sv_player.v.punchangle);
}

/*
===================
SV_WaterMove

===================
*/
export function SV_WaterMove(): void {
  const sv_player = requireSvPlayer();

  //
  // user intentions
  //
  AngleVectors(sv_player.v.v_angle, forward, right, up);

  const wishvel = vec3();
  for (let i = 0; i < 3; i++) wishvel[i] = forward[i] * cmd.forwardmove + right[i] * cmd.sidemove;

  if (!cmd.forwardmove && !cmd.sidemove && !cmd.upmove)
    wishvel[2] -= 60; // drift towards bottom
  else wishvel[2] += cmd.upmove;

  // the C shadows the module-global `wishspeed` with a local of the same
  // name inside this function -- named `wishspeedLocal` here since TS has no
  // equivalent implicit-shadow-of-an-exported-binding footgun to preserve.
  let wishspeedLocal = Length(wishvel);
  if (wishspeedLocal > sv_maxspeed.value) {
    VectorScale(wishvel, sv_maxspeed.value / wishspeedLocal, wishvel);
    wishspeedLocal = sv_maxspeed.value;
  }
  wishspeedLocal *= 0.7;

  //
  // water friction
  //
  const velocity = currentVelocity();
  const speed = Length(velocity);
  let newspeed: number;
  if (speed) {
    newspeed = speed - host.frametime * speed * sv_friction.value;
    if (newspeed < 0) newspeed = 0;
    VectorScale(velocity, newspeed / speed, velocity);
  } else {
    newspeed = 0;
  }

  //
  // water acceleration
  //
  if (!wishspeedLocal) return;

  const addspeed = wishspeedLocal - newspeed;
  if (addspeed <= 0) return;

  VectorNormalize(wishvel);
  let accelspeed = sv_accelerate.value * wishspeedLocal * host.frametime;
  if (accelspeed > addspeed) accelspeed = addspeed;

  for (let i = 0; i < 3; i++) velocity[i] += accelspeed * wishvel[i];
}

export function SV_WaterJump(): void {
  const sv_player = requireSvPlayer();

  if (sv.time > sv_player.v.teleport_time || !sv_player.v.waterlevel) {
    sv_player.v.flags = (sv_player.v.flags | 0) & ~FL_WATERJUMP;
    sv_player.v.teleport_time = 0;
  }
  sv_player.v.velocity[0] = sv_player.v.movedir[0];
  sv_player.v.velocity[1] = sv_player.v.movedir[1];
}

/*
===================
SV_AirMove

===================
*/
export function SV_AirMove(): void {
  const sv_player = requireSvPlayer();

  AngleVectors(sv_player.v.angles, forward, right, up);

  let fmove = cmd.forwardmove;
  const smove = cmd.sidemove;

  // hack to not let you back into teleporter
  if (sv.time < sv_player.v.teleport_time && fmove < 0) fmove = 0;

  const wishvel = vec3();
  for (let i = 0; i < 3; i++) wishvel[i] = forward[i] * fmove + right[i] * smove;

  if ((sv_player.v.movetype | 0) !== MOVETYPE_WALK) wishvel[2] = cmd.upmove;
  else wishvel[2] = 0;

  VectorCopy(wishvel, wishdir);
  wishspeed = VectorNormalize(wishdir);
  if (wishspeed > sv_maxspeed.value) {
    VectorScale(wishvel, sv_maxspeed.value / wishspeed, wishvel);
    wishspeed = sv_maxspeed.value;
  }

  if (sv_player.v.movetype === MOVETYPE_NOCLIP) {
    // noclip
    VectorCopy(wishvel, currentVelocity());
  } else if (onground) {
    SV_UserFriction();
    SV_Accelerate();
  } else {
    // not on ground, so little effect on velocity
    SV_AirAccelerate(wishvel);
  }
}

//============================================================================
// V_CalcRoll (view.c, client-side, not landed) -- see file header.
function V_CalcRoll(angles: Vec3, velocity: Vec3): number {
  const vForward = vec3();
  const vRight = vec3();
  const vUp = vec3();
  AngleVectors(angles, vForward, vRight, vUp);
  let side = DotProduct(velocity, vRight);
  const sign = side < 0 ? -1 : 1;
  side = Math.abs(side);

  const cl_rollangle = Cvar_FindVar("cl_rollangle");
  const cl_rollspeed = Cvar_FindVar("cl_rollspeed");
  const rollangleValue = cl_rollangle ? cl_rollangle.value : 2.0;
  const rollspeedValue = cl_rollspeed ? cl_rollspeed.value : 200;

  const value = rollangleValue;
  //	if (cl.inwater)
  //		value *= 6;

  if (side < rollspeedValue) side = (side * value) / rollspeedValue;
  else side = value;

  return side * sign;
}

/*
===================
SV_ClientThink

the move fields specify an intended velocity in pix/sec
the angle fields specify an exact angular motion in degrees
===================
*/
export function SV_ClientThink(): void {
  const sv_player = requireSvPlayer();

  if (sv_player.v.movetype === MOVETYPE_NONE) return;

  onground = ((sv_player.v.flags | 0) & FL_ONGROUND) !== 0;

  DropPunchAngle();

  //
  // if dead, behave differently
  //
  if (sv_player.v.health <= 0) return;

  //
  // angles
  // show 1/3 the pitch angle and all the roll angle
  const host_client = requireHostClient();
  copyUsercmd(cmd, host_client.cmd);
  const angles = sv_player.v.angles;

  const v_angle = vec3();
  VectorAdd(sv_player.v.v_angle, sv_player.v.punchangle, v_angle);
  angles[ROLL] = V_CalcRoll(sv_player.v.angles, sv_player.v.velocity) * 4;
  if (!sv_player.v.fixangle) {
    angles[PITCH] = -v_angle[PITCH] / 3;
    angles[YAW] = v_angle[YAW];
  }

  if ((sv_player.v.flags | 0) & FL_WATERJUMP) {
    SV_WaterJump();
    return;
  }

  //
  // walk
  //
  if (sv_player.v.waterlevel >= 2 && sv_player.v.movetype !== MOVETYPE_NOCLIP) {
    SV_WaterMove();
    return;
  }

  SV_AirMove();
}

/*
===================
SV_ReadClientMove
===================
*/
export function SV_ReadClientMove(move: UsercmdT): void {
  const host_client = requireHostClient();

  // read ping time
  host_client.ping_times[host_client.num_pings % NUM_PING_TIMES] = sv.time - MSG_ReadFloat();
  host_client.num_pings++;

  // read current angles
  const angle = vec3();
  for (let i = 0; i < 3; i++) angle[i] = MSG_ReadAngle();

  const edict = requireEdict(host_client);
  VectorCopy(angle, edict.v.v_angle);

  // read movement
  move.forwardmove = MSG_ReadShort();
  move.sidemove = MSG_ReadShort();
  move.upmove = MSG_ReadShort();

  // read buttons
  const bits = MSG_ReadByte();
  edict.v.button0 = bits & 1;
  edict.v.button2 = (bits & 2) >> 1;

  const i = MSG_ReadByte();
  if (i) edict.v.impulse = i;

  // #ifdef QUAKE2 -- read light level: dropped, never defined in a WinQuake build.
}

/*
===================
SV_ReadClientMessage

Returns false if the client should be killed
===================
*/
export function SV_ReadClientMessage(): boolean {
  const host_client = requireHostClient();

  for (;;) {
    const ret = NET_GetMessage(host_client.netconnection);
    if (ret === -1) {
      Sys_Printf("SV_ReadClientMessage: NET_GetMessage failed\n");
      return false;
    }
    if (!ret) return true;

    MSG_BeginReading();

    for (;;) {
      if (!host_client.active) return false; // a command caused an error

      if (msgState.badread) {
        Sys_Printf("SV_ReadClientMessage: badread\n");
        return false;
      }

      const cmdOp = MSG_ReadChar();

      if (cmdOp === -1) break; // goto nextmsg -- end of message

      switch (cmdOp) {
        case ClcOpsT.clc_nop:
          //				Sys_Printf ("clc_nop\n");
          break;

        case ClcOpsT.clc_stringcmd: {
          const s = MSG_ReadString();
          let ret2: number;
          if (host_client.privileged) ret2 = 2;
          else ret2 = 0;

          if (Q_strncasecmp(s, "status", 6) === 0) ret2 = 1;
          else if (Q_strncasecmp(s, "god", 3) === 0) ret2 = 1;
          else if (Q_strncasecmp(s, "notarget", 8) === 0) ret2 = 1;
          else if (Q_strncasecmp(s, "fly", 3) === 0) ret2 = 1;
          else if (Q_strncasecmp(s, "name", 4) === 0) ret2 = 1;
          else if (Q_strncasecmp(s, "noclip", 6) === 0) ret2 = 1;
          else if (Q_strncasecmp(s, "say", 3) === 0) ret2 = 1;
          else if (Q_strncasecmp(s, "say_team", 8) === 0) ret2 = 1;
          else if (Q_strncasecmp(s, "tell", 4) === 0) ret2 = 1;
          else if (Q_strncasecmp(s, "color", 5) === 0) ret2 = 1;
          else if (Q_strncasecmp(s, "kill", 4) === 0) ret2 = 1;
          else if (Q_strncasecmp(s, "pause", 5) === 0) ret2 = 1;
          else if (Q_strncasecmp(s, "spawn", 5) === 0) ret2 = 1;
          else if (Q_strncasecmp(s, "begin", 5) === 0) ret2 = 1;
          else if (Q_strncasecmp(s, "prespawn", 8) === 0) ret2 = 1;
          else if (Q_strncasecmp(s, "kick", 4) === 0) ret2 = 1;
          else if (Q_strncasecmp(s, "ping", 4) === 0) ret2 = 1;
          else if (Q_strncasecmp(s, "give", 4) === 0) ret2 = 1;
          else if (Q_strncasecmp(s, "ban", 3) === 0) ret2 = 1;

          if (ret2 === 2) Cbuf_InsertText(s);
          else if (ret2 === 1) Cmd_ExecuteString(s, CmdSourceT.src_client);
          else Con_DPrintf("%s tried to %s\n", host_client.name, s);
          break;
        }

        case ClcOpsT.clc_disconnect:
          //				Sys_Printf ("SV_ReadClientMessage: client disconnected\n");
          return false;

        case ClcOpsT.clc_move:
          SV_ReadClientMove(host_client.cmd);
          break;

        default:
          Sys_Printf("SV_ReadClientMessage: unknown command char\n");
          return false;
      }
    }
  }
}

/*
==================
SV_RunClients
==================
*/
export function SV_RunClients(): void {
  for (let i = 0; i < svs.maxclients; i++) {
    const host_client = svs.clients[i];
    if (!host_client.active) continue;

    svState.host_client = host_client;
    svState.sv_player = host_client.edict;

    if (!SV_ReadClientMessage()) {
      if (svMainHooks.dropClient) svMainHooks.dropClient(false); // client misbehaved...
      else Sys_Error("SV_RunClients: SV_DropClient unavailable (sv_main.ts not loaded)");
      continue;
    }

    if (!host_client.spawned) {
      // clear client movement until a new packet is received
      host_client.cmd = new UsercmdT();
      continue;
    }

    // always pause in single player if in console or menus
    const keyDestIsGame = svUserHooks.keyDestIsGame ? svUserHooks.keyDestIsGame() : true;
    if (!sv.paused && (svs.maxclients > 1 || keyDestIsGame)) SV_ClientThink();
  }
}
