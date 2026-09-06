/*
The 2021 re-release's engine-side builtins: the eighteen `= #0:ex_*` names
quakec/defs.qc:683-785 binds, quakec_ctf/defs.qc:839-843's three prompt
builtins and `setcolor` at #401, and the extension registry `checkextension`
answers from.

The named ones are handed to the NetQuake profile as `namedBuiltins`
(src/progs/profiles/nq.ts), which src/progs/pr_edict_core.ts's PR_InitBuiltins
binds after load the way Ironwail's own PR_InitBuiltins
(Quake/pr_edict.c:1857-1900) does. `setcolor` is a numbered builtin and lives
in src/progs/pr_cmds.ts's table at slot 401, with `checkextension` at 99.

Where the reference engines stop
--------------------------------
Ironwail implements `ex_bprint`/`ex_sprint`/`ex_centerprint` (through its
LOC-aware PF_VarString) and `ex_localsound`, and stubs `ex_finaleFinished`,
`ex_CheckPlayerEXFlags` and `ex_walkpathtogoal` to a constant 0
(Quake/pr_cmds.c:1724-1751). vkQuake registers the nine `ex_draw_*` and the two
`ex_bot_*` as `PF_NotImplemented` (Quake/pr_ext.c:5769-5780) -- which is where
their argument lists are confirmed -- and QuakeSpasm patches all of those names
to builtin slots nothing fills (Quake/pr_edict.c:1113-1160). None of the three
has `setcolor`, the prompt builtins, or an implementation of the two bot
builtins. So:

- `ex_finaleFinished` is real here rather than a constant 0. The QuakeC polls
  it every 0.1s from the finale's think chain (quakec/monsters/shub.qc:291 and
  its hipnotic/rogue twins) and advances when it answers true; the re-release's
  own behaviour is "the finale ends when a player presses attack". This
  implementation watches every client's `button0` for a 0->1 edge and answers
  true from then until the finale is over. A finale is over when the polling
  stops: a call that arrives more than FINALE_POLL_GAP seconds of server time
  after the previous one starts a fresh finale, which is what makes this
  better than a stub across a level with two finales. SV_SpawnServer resets it
  as well.
- `ex_CheckPlayerEXFlags` answers with a per-client flag word. NetQuake has no
  userinfo to carry a client preference in, so the client sends one: the
  `ex_flags <bits>` string command (registered in src/server/sv_main.ts,
  allowed in src/server/sv_user.ts's clc_stringcmd filter, sent by
  src/client/cl_main.ts's CL_SignonReply from the `cl_weaponswitch` cvar).
  Bits are quakec/defs.qc:444-445's own PEF_CHANGEONLYNEW/PEF_CHANGENEVER, and
  the default with no command received is PEF_CHANGEONLYNEW, which is the
  re-release's own default behaviour (only auto-switch to a weapon the player
  did not already have).
- `ex_walkpathtogoal` and the two `ex_bot_*` answer PATH_ERROR/BOT_GOAL_ERROR
  through src/progs/ext/qex_hooks.ts, which the nav and bot units fill. The
  QuakeC handles that answer itself: ai.qc's ai_pathtogoal falls back to
  `movetogoal(dist)`.
- The nine `ex_draw_*` record into src/progs/ext/qex_draw.ts's shape list under
  the `sv_debugdraw` cvar, and are no-ops when it is 0.
- The three prompt builtins and `setcolor` are ours end to end; the wire
  payloads are documented in src/common/protocol.ts.
*/

import { Con_Printf } from "../../client/console";
import { MSG_WriteByte, MSG_WriteShort, MSG_WriteString } from "../../common/sizebuf";
import { PROMPT_BEGIN, PROMPT_CHOICE, PROMPT_CLEAR, SND_LARGESOUND, SvcOpsT, svc_localsound, svc_prompt } from "../../common/protocol";
import { vec3, VectorCopy } from "../../common/mathlib";
import { MAX_SOUNDS } from "../../common/quakedef";
import { ClientT, sv, svs } from "../../server/server";
import { OFS_PARM0, OFS_PARM1, OFS_PARM2, OFS_PARM3, OFS_PARM4, OFS_PARM5, OFS_PARM6, OFS_RETURN } from "../pr_comp";
import { G_EDICT, G_EDICTNUM, G_FLOAT, G_STRING, G_VECTOR, PROG_TO_EDICT, pr } from "../progs";
import { type BuiltinT } from "../pr_exec";
import { QEX_LocGetString, QEX_VarString } from "./qex_print";
import { QEX_DebugDrawAdd, QEX_DebugDrawEnabled } from "./qex_draw";
import { BOT_GOAL_ERROR, PATH_ERROR, qexBotHooks, qexNavHooks } from "./qex_hooks";
import { SV_RulesetIsRerelease } from "./ruleset";
import { PEF_CHANGEONLYNEW } from "./constants";
import { PR_ActiveProfile } from "../profiles/profile";

export { PEF_CHANGENEVER, PEF_CHANGEONLYNEW, SETCOLOR_BUILTIN } from "./constants";

/** A `ex_flags` word that has never been set by its client. */
const PEF_DEFAULT = PEF_CHANGEONLYNEW;

/** Two polls further apart than this (server seconds) belong to two different
 * finales. The QuakeC polls at 0.1s. */
const FINALE_POLL_GAP = 1.0;

//============================================================================
// per-client engine state. client_t (src/server/server.ts) is another unit's
// file, so the two words this unit needs per client live here, indexed by
// client slot and cleared by QEX_ClearClient / QEX_ClearLevel.

const clientExFlags: number[] = [];
const finaleButtonHeld: boolean[] = [];

let finaleFinished = false;
let finaleLastPoll = -1e9;

export function QEX_ClearClient(index: number): void {
  clientExFlags[index] = PEF_DEFAULT;
  finaleButtonHeld[index] = false;
}

/** SV_SpawnServer: a new level has no prompts, no finale and no client flags
 * carried over. */
export function QEX_ClearLevel(): void {
  clientExFlags.length = 0;
  finaleButtonHeld.length = 0;
  finaleFinished = false;
  finaleLastPoll = -1e9;
}

export function QEX_SetClientExFlags(index: number, flags: number): void {
  clientExFlags[index] = flags | 0;
}

export function QEX_ClientExFlags(index: number): number {
  const flags = clientExFlags[index];
  return flags === undefined ? PEF_DEFAULT : flags;
}

/** Test/inspection accessor for the finale latch. */
export function QEX_FinaleFinished(): boolean {
  return finaleFinished;
}

function clientForEdictNum(entnum: number, what: string): ClientT | null {
  if (entnum < 1 || entnum > svs.maxclients) {
    Con_Printf("tried to %s to a non-client\n", what);
    return null;
  }
  return svs.clients[entnum - 1];
}

//============================================================================
// prints

/*
=================
PF_ex_bprint

void(string s, ...) bprint = #0:ex_bprint
=================
*/
function PF_ex_bprint(): void {
  const s = QEX_VarString(0);
  for (let i = 0; i < svs.maxclients; i++) {
    const client = svs.clients[i];
    if (client.active && client.spawned) {
      MSG_WriteByte(client.message, SvcOpsT.svc_print);
      MSG_WriteString(client.message, s);
    }
  }
}

/*
=================
PF_ex_sprint

void(entity client, string s, ...) sprint = #0:ex_sprint
=================
*/
function PF_ex_sprint(): void {
  const entnum = G_EDICTNUM(OFS_PARM0);
  const s = QEX_VarString(1);
  const client = clientForEdictNum(entnum, "sprint");
  if (client === null) return;

  MSG_WriteByte(client.message, SvcOpsT.svc_print);
  MSG_WriteString(client.message, s);
}

/*
=================
PF_ex_centerprint

void(entity client, string s, ...) centerprint = #0:ex_centerprint
=================
*/
function PF_ex_centerprint(): void {
  const entnum = G_EDICTNUM(OFS_PARM0);
  const s = QEX_VarString(1);
  // the C's own copy-pasted "tried to sprint" wording, kept
  const client = clientForEdictNum(entnum, "sprint");
  if (client === null) return;

  MSG_WriteByte(client.message, SvcOpsT.svc_centerprint);
  MSG_WriteString(client.message, s);
}

//============================================================================
// finale

/*
=================
PF_ex_finaleFinished

float() finaleFinished = #0:ex_finaleFinished
=================
*/
function PF_ex_finaleFinished(): void {
  const globals = pr.globals;
  const time = sv.time;

  if (time - finaleLastPoll > FINALE_POLL_GAP) {
    // the previous finale, if any, is long over: this poll opens a new one,
    // and a button already held when it opens does not count.
    finaleFinished = false;
    for (let i = 0; i < svs.maxclients; i++) {
      const client = svs.clients[i];
      finaleButtonHeld[i] = client.active && client.edict !== null && client.edict.v.button0 !== 0;
    }
  }
  finaleLastPoll = time;

  for (let i = 0; i < svs.maxclients; i++) {
    const client = svs.clients[i];
    const edict = client.edict;
    const down = client.active && edict !== null && edict.v.button0 !== 0;
    if (down && !finaleButtonHeld[i]) finaleFinished = true;
    finaleButtonHeld[i] = down;
  }

  if (globals !== null) globals.f[OFS_RETURN] = finaleFinished ? 1 : 0;
}

//============================================================================
// localsound

/*
=================
SV_LocalSound

Ironwail's own SV_LocalSound, defined by the reader it feeds
(Quake/cl_parse.c:200-213's CL_ParseLocalSound): a flags byte carrying
SND_LARGESOUND when the index does not fit in a byte, then the sound number.
=================
*/
export function SV_LocalSound(client: ClientT, sample: string): void {
  let sound_num = -1;
  for (let i = 1; i < MAX_SOUNDS && sv.sound_precache[i] !== undefined && sv.sound_precache[i] !== ""; i++) {
    if (sv.sound_precache[i] === sample) {
      sound_num = i;
      break;
    }
  }
  if (sound_num === -1) {
    Con_Printf("SV_LocalSound: %s not precached\n", sample);
    return;
  }

  MSG_WriteByte(client.message, svc_localsound);
  if (sound_num > 255) {
    MSG_WriteByte(client.message, SND_LARGESOUND);
    MSG_WriteShort(client.message, sound_num);
  } else {
    MSG_WriteByte(client.message, 0);
    MSG_WriteByte(client.message, sound_num);
  }
}

/*
=================
PF_ex_localsound

void localsound(entity client, string sample) = #0:ex_localsound
Ironwail Quake/pr_cmds.c:1739-1751.
=================
*/
function PF_ex_localsound(): void {
  const entnum = G_EDICTNUM(OFS_PARM0);
  const sample = G_STRING(OFS_PARM1);
  const client = clientForEdictNum(entnum, "localsound");
  if (client === null) return;
  SV_LocalSound(client, sample);
}

//============================================================================
// debug draw. Argument lists from quakec/defs.qc:767-775, confirmed against
// vkQuake Quake/pr_ext.c:5769-5778's own signature strings.

function drawTime(): number {
  return sv.time;
}

function PF_ex_draw_point(): void {
  if (!QEX_DebugDrawEnabled()) return;
  QEX_DebugDrawAdd({ kind: "point", a: G_VECTOR(OFS_PARM0), colormap: G_FLOAT(OFS_PARM1), lifetime: G_FLOAT(OFS_PARM2), depthtest: G_FLOAT(OFS_PARM3), time: drawTime() });
}

function PF_ex_draw_line(): void {
  if (!QEX_DebugDrawEnabled()) return;
  QEX_DebugDrawAdd({
    kind: "line",
    a: G_VECTOR(OFS_PARM0),
    b: G_VECTOR(OFS_PARM1),
    colormap: G_FLOAT(OFS_PARM2),
    lifetime: G_FLOAT(OFS_PARM3),
    depthtest: G_FLOAT(OFS_PARM4),
    time: drawTime(),
  });
}

function PF_ex_draw_arrow(): void {
  if (!QEX_DebugDrawEnabled()) return;
  QEX_DebugDrawAdd({
    kind: "arrow",
    a: G_VECTOR(OFS_PARM0),
    b: G_VECTOR(OFS_PARM1),
    colormap: G_FLOAT(OFS_PARM2),
    size: G_FLOAT(OFS_PARM3),
    lifetime: G_FLOAT(OFS_PARM4),
    depthtest: G_FLOAT(OFS_PARM5),
    time: drawTime(),
  });
}

function PF_ex_draw_ray(): void {
  if (!QEX_DebugDrawEnabled()) return;
  QEX_DebugDrawAdd({
    kind: "ray",
    a: G_VECTOR(OFS_PARM0),
    b: G_VECTOR(OFS_PARM1),
    radius: G_FLOAT(OFS_PARM2),
    colormap: G_FLOAT(OFS_PARM3),
    size: G_FLOAT(OFS_PARM4),
    lifetime: G_FLOAT(OFS_PARM5),
    depthtest: G_FLOAT(OFS_PARM6),
    time: drawTime(),
  });
}

function PF_ex_draw_circle(): void {
  if (!QEX_DebugDrawEnabled()) return;
  QEX_DebugDrawAdd({
    kind: "circle",
    a: G_VECTOR(OFS_PARM0),
    radius: G_FLOAT(OFS_PARM1),
    colormap: G_FLOAT(OFS_PARM2),
    lifetime: G_FLOAT(OFS_PARM3),
    depthtest: G_FLOAT(OFS_PARM4),
    time: drawTime(),
  });
}

function PF_ex_draw_bounds(): void {
  if (!QEX_DebugDrawEnabled()) return;
  QEX_DebugDrawAdd({
    kind: "bounds",
    a: G_VECTOR(OFS_PARM0),
    b: G_VECTOR(OFS_PARM1),
    colormap: G_FLOAT(OFS_PARM2),
    lifetime: G_FLOAT(OFS_PARM3),
    depthtest: G_FLOAT(OFS_PARM4),
    time: drawTime(),
  });
}

function PF_ex_draw_worldtext(): void {
  if (!QEX_DebugDrawEnabled()) return;
  QEX_DebugDrawAdd({
    kind: "worldtext",
    text: G_STRING(OFS_PARM0),
    a: G_VECTOR(OFS_PARM1),
    size: G_FLOAT(OFS_PARM2),
    colormap: 0,
    lifetime: G_FLOAT(OFS_PARM3),
    depthtest: G_FLOAT(OFS_PARM4),
    time: drawTime(),
  });
}

function PF_ex_draw_sphere(): void {
  if (!QEX_DebugDrawEnabled()) return;
  QEX_DebugDrawAdd({
    kind: "sphere",
    a: G_VECTOR(OFS_PARM0),
    radius: G_FLOAT(OFS_PARM1),
    colormap: G_FLOAT(OFS_PARM2),
    lifetime: G_FLOAT(OFS_PARM3),
    depthtest: G_FLOAT(OFS_PARM4),
    time: drawTime(),
  });
}

function PF_ex_draw_cylinder(): void {
  if (!QEX_DebugDrawEnabled()) return;
  QEX_DebugDrawAdd({
    kind: "cylinder",
    a: G_VECTOR(OFS_PARM0),
    size: G_FLOAT(OFS_PARM1),
    radius: G_FLOAT(OFS_PARM2),
    colormap: G_FLOAT(OFS_PARM3),
    lifetime: G_FLOAT(OFS_PARM4),
    depthtest: G_FLOAT(OFS_PARM5),
    time: drawTime(),
  });
}

//============================================================================
// bots and navigation

function returnFloat(value: number): void {
  const globals = pr.globals;
  if (globals !== null) globals.f[OFS_RETURN] = value;
}

/*
=================
PF_ex_bot_movetopoint

float bot_movetopoint(entity bot, vector point) = #0:ex_bot_movetopoint
=================
*/
function PF_ex_bot_movetopoint(): void {
  const hook = qexBotHooks.movetopoint;
  if (hook === null) {
    returnFloat(BOT_GOAL_ERROR);
    return;
  }
  const bot = G_EDICT(OFS_PARM0);
  const point = vec3();
  VectorCopy(G_VECTOR(OFS_PARM1), point);
  returnFloat(hook(bot, point));
}

/*
=================
PF_ex_bot_followentity

float bot_followentity(entity bot, entity goal) = #0:ex_bot_followentity
=================
*/
function PF_ex_bot_followentity(): void {
  const hook = qexBotHooks.followentity;
  if (hook === null) {
    returnFloat(BOT_GOAL_ERROR);
    return;
  }
  returnFloat(hook(G_EDICT(OFS_PARM0), G_EDICT(OFS_PARM1)));
}

/*
=================
PF_ex_walkpathtogoal

float walkpathtogoal(float movedist, vector goal) = #0:ex_walkpathtogoal

Acts on `self`, the monster the QuakeC is running (quakec/ai.qc's
ai_pathtogoal). PATH_ERROR is the QuakeC's own fallback signal: ai_pathtogoal
calls movetogoal(dist) for anything that is not PATH_IN_PROGRESS.
=================
*/
function PF_ex_walkpathtogoal(): void {
  const hook = qexNavHooks.walkpathtogoal;
  if (hook === null) {
    returnFloat(PATH_ERROR);
    return;
  }
  const gs = pr.global_struct;
  if (gs === null) {
    returnFloat(PATH_ERROR);
    return;
  }
  const goal = vec3();
  VectorCopy(G_VECTOR(OFS_PARM1), goal);
  returnFloat(hook(PROG_TO_EDICT(gs.self), G_FLOAT(OFS_PARM0), goal));
}

//============================================================================
// player extension flags

/*
=================
PF_ex_CheckPlayerEXFlags

float CheckPlayerEXFlags(entity playerEnt) = #0:ex_CheckPlayerEXFlags

quakec/weapons.qc:862-876's W_WantsToChangeWeapon reads PEF_CHANGENEVER and
PEF_CHANGEONLYNEW out of the answer to decide whether picking a weapon up
switches to it.
=================
*/
function PF_ex_CheckPlayerEXFlags(): void {
  const entnum = G_EDICTNUM(OFS_PARM0);
  if (entnum < 1 || entnum > svs.maxclients) {
    returnFloat(0);
    return;
  }
  returnFloat(QEX_ClientExFlags(entnum - 1));
}

//============================================================================
// prompts (quakec_ctf/defs.qc:841-843)

function PF_ex_prompt(): void {
  // `void prompt(entity client, string text, float numChoices)` is not
  // variadic (quakec_ctf/defs.qc:841), so the text is one string -- localized,
  // since status.qc passes "$qc_ctf_intro".
  const entnum = G_EDICTNUM(OFS_PARM0);
  const text = QEX_LocGetString(G_STRING(OFS_PARM1));
  const numChoices = G_FLOAT(OFS_PARM2) | 0;
  const client = clientForEdictNum(entnum, "prompt");
  if (client === null) return;

  MSG_WriteByte(client.message, svc_prompt);
  MSG_WriteByte(client.message, PROMPT_BEGIN);
  MSG_WriteString(client.message, text);
  MSG_WriteByte(client.message, numChoices & 0xff);
}

function PF_ex_promptchoice(): void {
  const entnum = G_EDICTNUM(OFS_PARM0);
  const text = QEX_LocGetString(G_STRING(OFS_PARM1));
  const impulse = G_FLOAT(OFS_PARM2) | 0;
  const client = clientForEdictNum(entnum, "promptchoice");
  if (client === null) return;

  MSG_WriteByte(client.message, svc_prompt);
  MSG_WriteByte(client.message, PROMPT_CHOICE);
  MSG_WriteString(client.message, text);
  MSG_WriteByte(client.message, impulse & 0xff);
}

function PF_ex_clearprompt(): void {
  const entnum = G_EDICTNUM(OFS_PARM0);
  const client = clientForEdictNum(entnum, "clearprompt");
  if (client === null) return;

  MSG_WriteByte(client.message, svc_prompt);
  MSG_WriteByte(client.message, PROMPT_CLEAR);
}

//============================================================================
// numbered builtins: checkextension (99) and setcolor (401)

/*
=================
PF_checkextension

float checkextension(string s) = #99

Answers from the active profile's extension registry. This is the same builtin
src/progs/pr_edict_core.ts installs at slot 99 when a profile's numbered table
stops short of it; the NetQuake table now reaches 401 for `setcolor`, so it
carries its own copy at 99 instead.
=================
*/
export function PF_checkextension(): void {
  const profile = PR_ActiveProfile();
  const globals = profile.state.globals;
  if (globals === null) return;
  const name = G_STRING(OFS_PARM0);
  globals.f[OFS_RETURN] = profile.extensions.has(name) ? 1 : 0;
}

/*
=================
PF_setcolor

void setcolor(entity client, float color) = #401

quakec_ctf/teamplay.qc:144-151 packs `bottom + top * 16` into the one float and
calls this in place of `stuffcmd(self, "color <top> <bottom>")`. The engine side
is Host_Color_f's (src/common/host_cmd.ts): store the packed byte on the
client, put `bottom + 1` in the player's `team` field, and tell everyone.
=================
*/
export function PF_setcolor(): void {
  const entnum = G_EDICTNUM(OFS_PARM0);
  const client = clientForEdictNum(entnum, "setcolor");
  if (client === null) return;

  let top = (G_FLOAT(OFS_PARM1) | 0) >> 4;
  let bottom = (G_FLOAT(OFS_PARM1) | 0) & 15;
  top &= 15;
  if (top > 13) top = 13;
  bottom &= 15;
  if (bottom > 13) bottom = 13;
  const playercolor = top * 16 + bottom;

  client.colors = playercolor;
  if (client.edict !== null) client.edict.v.team = bottom + 1;

  MSG_WriteByte(sv.reliable_datagram, SvcOpsT.svc_updatecolors);
  MSG_WriteByte(sv.reliable_datagram, entnum - 1);
  MSG_WriteByte(sv.reliable_datagram, client.colors);
}

//============================================================================
// the tables the profile hands to the VM

const namedBuiltins = new Map<string, BuiltinT>([
  ["ex_bprint", PF_ex_bprint],
  ["ex_sprint", PF_ex_sprint],
  ["ex_centerprint", PF_ex_centerprint],
  ["ex_finaleFinished", PF_ex_finaleFinished],
  ["ex_localsound", PF_ex_localsound],
  ["ex_draw_point", PF_ex_draw_point],
  ["ex_draw_line", PF_ex_draw_line],
  ["ex_draw_arrow", PF_ex_draw_arrow],
  ["ex_draw_ray", PF_ex_draw_ray],
  ["ex_draw_circle", PF_ex_draw_circle],
  ["ex_draw_bounds", PF_ex_draw_bounds],
  ["ex_draw_worldtext", PF_ex_draw_worldtext],
  ["ex_draw_sphere", PF_ex_draw_sphere],
  ["ex_draw_cylinder", PF_ex_draw_cylinder],
  ["ex_bot_movetopoint", PF_ex_bot_movetopoint],
  ["ex_bot_followentity", PF_ex_bot_followentity],
  ["ex_CheckPlayerEXFlags", PF_ex_CheckPlayerEXFlags],
  ["ex_walkpathtogoal", PF_ex_walkpathtogoal],
  ["ex_prompt", PF_ex_prompt],
  ["ex_promptchoice", PF_ex_promptchoice],
  ["ex_clearprompt", PF_ex_clearprompt],
]);

export function QEX_NamedBuiltins(): ReadonlyMap<string, BuiltinT> {
  return namedBuiltins;
}

// The registry `checkextension` answers 1 for. Every string here is one the
// re-release QuakeC actually asks about (quakec/monsters/ogre.qc:141,
// quakec/player.qc:525, quakec_ctf/defs.qc:888, quakec_ctf/teamplay.qc:148);
// nothing answers under the classic profile, where none of the behaviour
// behind these names is switched on.
const RERELEASE_EXTENSIONS: ReadonlySet<string> = new Set(["EX_EXTENDED_EF", "EX_MOVETYPE_GIB", "EX_PROMPT", "DP_SV_SETCOLOR"]);
const NO_EXTENSIONS: ReadonlySet<string> = new Set<string>();

export function QEX_Extensions(): ReadonlySet<string> {
  return SV_RulesetIsRerelease() ? RERELEASE_EXTENSIONS : NO_EXTENSIONS;
}
