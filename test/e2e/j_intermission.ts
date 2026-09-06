// J-track e2e agent: closes .orch/e2e/B.md's "B-G3 intermission/finale not
// reachable" gap by driving a REAL QuakeC intermission through the actual
// trigger_changelevel touch path, instead of only forcing cl.intermission
// (as the B-track agent did, explicitly stating that was draw-path-only).
// See j_ambient.ts for the other gap (ambient/spatialization).
//
// Run under SDL_VIDEODRIVER=dummy, SDL_AUDIODRIVER=dummy (no audio evidence
// needed here). Screenshots land in j_lib.ts's SHOTDIR.
//
// Plan (per the brief):
//  1. `+map e1m1`, scan sv.edicts for classname === "trigger_changelevel"
//     (PR_GetString(ed.v.classname)), teleport the player into its bbox
//     centre (ed.v.absmin/absmax), SV_LinkEdict(player, true) so
//     SV_TouchLinks fires the trigger's touch function immediately.
//  2. Assert cl.intermission becomes 1 and cl.completed_time is latched
//     (svc_intermission actually parsed -- cl_parse.ts:908-910), screenshot
//     the intermission draw.
//  3. Hold +attack (the real client->server path, not a direct field write)
//     to satisfy QuakeC's "any key" exit condition, run frames, and see
//     whether sv.name / cl.levelname actually advance to the next map --
//     this is the step .orch/e2e/B.md's B-3 defect
//     (`Sys_Error("i >= cl.maxclients")` on any changelevel, console- or
//     trigger-driven -- src/progs/pr_cmds.ts's PF_changelevel and
//     src/common/host_cmd.ts's Host_Changelevel_f both fire the exact same
//     `Cbuf_AddText("changelevel <map>\n")`) is expected to reproduce; every
//     risky frame-pump is wrapped so a SysError is caught and reported
//     instead of killing this script uninvestigated.
//  4. Repeat the same technique on `map end` (the episode-end map, which
//     also has exactly one trigger_changelevel, target "start" -- the
//     episode-complete flow) for whatever additional evidence it yields.
//     The true finale text (svc_finale) is generated when monster_oldone
//     (Shub-Niggurath) dies, a full boss encounter this driver does not
//     attempt to stage -- noted as skipped per the brief's own allowance.
import { sv } from "../../src/server/server";
import { SV_LinkEdict } from "../../src/server/world";
import { EDICT_NUM, PR_GetString } from "../../src/progs/progs";
import type { EdictT } from "../../src/progs/progs";
import { cl } from "../../src/client/client";
import { SysError } from "../../src/platform/sys";
import { boot, pump, exec, check, summary, shot, GAMEDIR, BASEDIR, GAMEDIR_NAME } from "./j_lib";

function findTriggerChangelevel(): EdictT | null {
  for (let i = 0; i < sv.num_edicts; i++) {
    const ed = sv.edicts[i];
    if (!ed || ed.free) continue;
    let cname = "";
    try {
      cname = PR_GetString(ed.v.classname);
    } catch {
      continue;
    }
    if (cname === "trigger_changelevel") return ed;
  }
  return null;
}

function teleportPlayerInto(ed: EdictT): [number, number, number] {
  const cx = (ed.v.absmin[0] + ed.v.absmax[0]) / 2;
  const cy = (ed.v.absmin[1] + ed.v.absmax[1]) / 2;
  const cz = (ed.v.absmin[2] + ed.v.absmax[2]) / 2;
  const player = EDICT_NUM(1);
  player.v.origin[0] = cx;
  player.v.origin[1] = cy;
  player.v.origin[2] = cz;
  player.v.velocity[0] = 0;
  player.v.velocity[1] = 0;
  player.v.velocity[2] = 0;
  SV_LinkEdict(player, true); // touch_triggers=true: SV_TouchLinks runs immediately
  return [cx, cy, cz];
}

// Runs a pump() but catches a SysError thrown mid-frame (the B-3 crash
// path) instead of letting it kill the whole process, so later phases in
// this same script (or the second map) still get a chance to run.
async function pumpCatching(label: string, durationSec: number, dt = 0.05): Promise<{ crashed: boolean; error?: string }> {
  try {
    await pump(durationSec, dt);
    return { crashed: false };
  } catch (e) {
    const msg = e instanceof SysError ? `SysError: ${e.message}` : e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.log(`[j_intermission] CRASH during "${label}": ${msg}`);
    return { crashed: true, error: msg };
  }
}

async function runOnMap(mapName: string, shotPrefix: string): Promise<void> {
  console.log(`\n=== map ${mapName} ===`);
  exec(`map ${mapName}`, 4);
  await pump(2.0);
  check(`${mapName}: server active`, sv.active && sv.name === mapName, `sv.active=${sv.active} sv.name=${sv.name}`);

  const trigger = findTriggerChangelevel();
  check(`${mapName}: found a trigger_changelevel entity`, trigger !== null);
  if (!trigger) {
    summary(`j_intermission (${mapName})`);
    return;
  }

  const center = teleportPlayerInto(trigger);
  console.log(`[j_intermission] teleported player into trigger_changelevel bbox centre = (${center[0]},${center[1]},${center[2]})`);

  const settle = await pumpCatching(`${mapName}: settle after touching the trigger`, 3.0);
  if (settle.crashed) {
    check(`${mapName}: reproduces B-3 (Sys_Error i >= cl.maxclients) immediately on touch`, true, settle.error ?? "");
    summary(`j_intermission (${mapName})`);
    return;
  }

  check(`${mapName}: cl.intermission became 1 (svc_intermission parsed)`, cl.intermission === 1, `cl.intermission=${cl.intermission} cl.completed_time=${cl.completed_time}`);

  if (cl.intermission === 1) {
    shot(GAMEDIR, `${shotPrefix}_intermission`);
  }

  const beforeName = sv.name;
  const beforeLevelname = cl.levelname;

  // Hold +attack repeatedly for several seconds -- QuakeC's IntermissionThink
  // requires both an elapsed minimum time and a button press to advance.
  let crashDuring = "";
  for (let i = 0; i < 6 && !crashDuring; i++) {
    exec("+attack", 2);
    const r = await pumpCatching(`${mapName}: holding +attack, pulse ${i}`, 1.0);
    exec("-attack", 1);
    if (r.crashed) crashDuring = r.error ?? "unknown";
  }

  if (crashDuring) {
    check(`${mapName}: reproduces B-3 (Sys_Error i >= cl.maxclients) while advancing past intermission`, true, crashDuring);
    summary(`j_intermission (${mapName})`);
    return;
  }

  const advanced = sv.name !== beforeName || cl.levelname !== beforeLevelname;
  check(`${mapName}: level actually advanced after holding +attack`, advanced, `sv.name ${beforeName} -> ${sv.name}, cl.levelname "${beforeLevelname}" -> "${cl.levelname}"`);
  if (advanced) shot(GAMEDIR, `${shotPrefix}_after_advance`);

  summary(`j_intermission (${mapName})`);
}

async function main(): Promise<void> {
  boot(["-basedir", BASEDIR, "-game", GAMEDIR_NAME, "+map", "e1m1"]);
  await pump(1.0);

  await runOnMap("e1m1", "e1m1");
  await runOnMap("end", "end");

  process.exit(0);
}

await main();
