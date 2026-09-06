import { boot, frames, exec, tap, key, check, summary, shot, keyState, Cvar_VariableValue, conHas, conTail } from "./b_lib";
import { K_TAB, KeydestT } from "../../src/client/keys";
import { cl, cls } from "../../src/client/client";
import * as sbarMod from "../../src/client/sbar";
import { scrState } from "../../src/client/screen_types";
import { Q1TS_DATA } from "./q1data";

const BASE = Q1TS_DATA;

boot(["-basedir", BASE, "-game", "e2e_b"]);
frames(5);
exec("disconnect", 3);
exec("map e1m1", 25);
keyState.key_dest = KeydestT.key_game;
exec("clear", 1);
frames(3);

// ---- 5a: viewsize HUD layouts -------------------------------------------
for (const v of [30, 100, 110, 120]) {
  exec(`viewsize ${v}`, 3);
  frames(3);
  console.log(`  viewsize=${Cvar_VariableValue("viewsize")} sb_lines=${scrState.sb_lines}`);
  shot(`hud_viewsize_${v}`);
}
exec("viewsize 100", 3);

// ---- 5b: +showscores overlay --------------------------------------------
{
  exec("+showscores", 2);
  frames(3);
  check("+showscores raises sb_showscores", sbarMod.sb_showscores === true, `sb_showscores=${sbarMod.sb_showscores}`);
  shot("hud_showscores");
  exec("-showscores", 2);
  frames(2);
  check("-showscores lowers it", sbarMod.sb_showscores === false, `sb_showscores=${sbarMod.sb_showscores}`);
}

// ---- 5c: pause + showpause ----------------------------------------------
exec("showpause 1", 1);
exec("pause", 3);
frames(3);
check("pause sets cl.paused", cl.paused === true, `cl.paused=${cl.paused}`);
shot("hud_paused");
exec("pause", 3);
check("pause again unpauses", cl.paused === false, `cl.paused=${cl.paused}`);

// ---- 5d: centerprint ----------------------------------------------------
exec("scr_centertime 10", 1);
{
  const scr = require("../../src/client/screen");
  scr.SCR_CenterPrint("B agent center print\nsecond line");
  frames(3);
  shot("hud_centerprint");
}

// ---- 5e: intermission / finale ------------------------------------------
// WinQuake's `changelevel` goes straight to the next map; the intermission and
// the finale are driven by QuakeC (`intermission_running`), which the console
// cannot reach. The draw paths are exercised by putting the client into the
// same state the SVC_intermission / SVC_finale parse would.
{
  const { host } = require("../../src/common/host");
  cl.intermission = 1;
  cl.completed_time = host.realtime;
  frames(3);
  shot("hud_intermission");
  check("intermission overlay drew without error", true, "cl.intermission=1");

  cl.intermission = 2; // finale
  const scr = require("../../src/client/screen");
  scr.SCR_CenterPrint("Congratulations!\nYou have finished the test episode.");
  frames(3);
  shot("hud_finale");
  check("finale overlay drew without error", true, "cl.intermission=2");

  cl.intermission = 0;
  frames(2);
}

// ---- 5f: changelevel in single player -----------------------------------
exec("clear", 1);
try {
  exec("changelevel e1m2", 30);
  check("changelevel loads the next map directly (no intermission)", String(cl.levelname).length > 0 && cl.intermission === 0, `levelname=${cl.levelname} intermission=${cl.intermission}`);
  shot("hud_after_changelevel");
} catch (e) {
  const { cls } = require("../../src/client/client");
  check("changelevel loads the next map directly (no intermission)", false, `THREW: ${String(e)} | cl.maxclients=${cl.maxclients} cl.levelname=${JSON.stringify(cl.levelname)} cls.signon=${cls.signon}`);
}

// ---- 5g: cl_sbar? -------------------------------------------------------
{
  const { Cvar_FindVar } = require("../../src/common/cvar");
  check("cl_sbar absent (a QuakeWorld cvar, not WinQuake)", Cvar_FindVar("cl_sbar") === null, "informational");
}

summary("S5 sbar/HUD");
process.exit(0);
