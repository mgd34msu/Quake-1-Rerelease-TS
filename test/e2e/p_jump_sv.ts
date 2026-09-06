// Instrumented qwsv for the p_jump / p_bhop drivers. Not a bun:test suite.
//
// Runs the real src/qw/main_sv.ts server, with two call-through spies that
// record what PlayerMove saw for every client command:
//
//   pmove.ts PlayerMove  -- cmd.buttons, pmove.oldbuttons before/after,
//                           PM_CatagorizePosition's onground, waterlevel,
//                           the gap between pmove.origin[2] and the floor
//                           under it, and velocity[2] before/after (the +270
//                           of JumpButton is visible as a step in that pair).
//   sv_send.ts SV_StartSound -- so "player/plyrjmp8.wav" (QC PlayerJump's
//                           sound, played from PlayerPreThink before
//                           PlayerMove runs) can be paired with the command
//                           it belongs to.
//
// One JSON object per client command is appended to the file named by
// `-jumplog <path>`; test/e2e/p_jump.ts reads it back.
import { spyOn } from "bun:test";
import * as pmoveMod from "../../src/qw/pmove";
import * as svSend from "../../src/qw/server/sv_send";
import { pmove, pmState, player_mins } from "../../src/qw/pmove_types";
import { PM_PlayerMove } from "../../src/qw/pmovetst";
import { vec3, VectorCopy } from "../../src/common/mathlib";
import { svState } from "../../src/qw/server/server";
import { main } from "../../src/qw/main_sv";
import { appendFileSync } from "node:fs";

const FL_ONGROUND = 512;
const FL_JUMPRELEASED = 4096;

const argv = process.argv.slice(2);
const logIndex = argv.indexOf("-jumplog");
const LOG = logIndex >= 0 ? argv[logIndex + 1] : "";
const serverArgs = argv.filter((_, i) => i !== logIndex && i !== logIndex + 1);

let pendingSounds: string[] = [];
const realStartSound = svSend.SV_StartSound;
const soundSpy = spyOn(svSend, "SV_StartSound");
soundSpy.mockImplementation((entity, channel, sample, volume, attenuation) => {
  pendingSounds.push(sample);
  realStartSound(entity, channel, sample, volume, attenuation);
});

const savedOrigin = vec3();
const savedVelocity = vec3();
const traceStart = vec3();
const traceEnd = vec3();

/**
 * Re-run PlayerMove's own prefix (NudgePosition, then PM_CatagorizePosition)
 * on a snapshot so the harness sees exactly the `onground`/`waterlevel`
 * JumpButton is about to be given, then undo it.
 */
function probe(): { onground: number; waterlevel: number; watertype: number; gap: number; originZ: number } {
  VectorCopy(pmove.origin, savedOrigin);
  VectorCopy(pmove.velocity, savedVelocity);
  const savedNumtouch = pmove.numtouch;
  const savedWaterjump = pmove.waterjumptime;

  pmoveMod.NudgePosition();
  pmoveMod.PM_CatagorizePosition();
  const onground = pmState.onground;
  const waterlevel = pmState.waterlevel;
  const watertype = pmState.watertype;
  const originZ = pmove.origin[2];

  // distance from the player's feet down to whatever is under them
  VectorCopy(savedOrigin, traceStart);
  VectorCopy(savedOrigin, traceEnd);
  traceEnd[2] = savedOrigin[2] - 8;
  const tr = PM_PlayerMove(traceStart, traceEnd);
  const gap = tr.fraction === 1 ? 8 : savedOrigin[2] - tr.endpos[2];

  VectorCopy(savedOrigin, pmove.origin);
  VectorCopy(savedVelocity, pmove.velocity);
  pmove.numtouch = savedNumtouch;
  pmove.waterjumptime = savedWaterjump;

  return { onground, waterlevel, watertype, gap, originZ };
}

let seq = 0;
let lastFlags = FL_JUMPRELEASED;

const realPlayerMove = pmoveMod.PlayerMove;
const moveSpy = spyOn(pmoveMod, "PlayerMove");
moveSpy.mockImplementation(() => {
  const player = svState.sv_player;
  if (player === null || pmove.spectator) {
    realPlayerMove();
    return;
  }

  const sounds = pendingSounds;
  pendingSounds = [];

  const flags = player.v.flags | 0;
  const button0 = player.v.button0;
  const button2 = player.v.button2;
  const qcWaterlevel = player.v.waterlevel;
  const health = player.v.health;
  const buttons = pmove.cmd.buttons;
  const oldbuttonsBefore = pmove.oldbuttons;
  const velBefore = [pmove.velocity[0], pmove.velocity[1], pmove.velocity[2]];
  const p = probe();

  realPlayerMove();

  const rec = {
    seq: seq++,
    msec: pmove.cmd.msec,
    buttons,
    oldbuttonsBefore,
    oldbuttonsAfter: pmove.oldbuttons,
    dead: pmove.dead,
    waterjumptime: pmove.waterjumptime,
    flags,
    lastFlags,
    button0,
    button2,
    qcWaterlevel,
    health,
    onground: p.onground,
    ongroundAfter: pmState.onground,
    waterlevel: p.waterlevel,
    watertype: p.watertype,
    gap: p.gap,
    originZ: p.originZ,
    feetZ: p.originZ + player_mins[2],
    velBefore,
    velAfter: [pmove.velocity[0], pmove.velocity[1], pmove.velocity[2]],
    sounds,
  };
  lastFlags = flags;
  if (LOG) appendFileSync(LOG, JSON.stringify(rec) + "\n");
});

void FL_ONGROUND;

await main(["p_jump_sv.ts", ...serverArgs]);
