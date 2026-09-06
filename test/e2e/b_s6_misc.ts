import { boot, frames, exec, check, summary, shot, conHas, conTail, keyState, Cvar_VariableValue } from "./b_lib";
import { KeydestT } from "../../src/client/keys";
import { cl, cls } from "../../src/client/client";
import { Q1TS_DATA } from "./q1data";

const BASE = Q1TS_DATA;

// +map on the command line goes through Cmd_StuffCmds_f, which quake.rc runs.
boot(["-basedir", BASE, "-game", "e2e_b", "-nosound", "+map", "e1m1", "+sensitivity", "6"]);
frames(30);
check("stuffcmds ran `+map e1m1` from the command line", String(cl.levelname).includes("Slipgate"), `levelname=${JSON.stringify(cl.levelname)}`);
check("stuffcmds ran `+sensitivity 6`", Cvar_VariableValue("sensitivity") === 6, `sensitivity=${Cvar_VariableValue("sensitivity")}`);

keyState.key_dest = KeydestT.key_game;
exec("clear", 1);

// playdemo
exec("playdemo demo1", 30);
check("playdemo demo1 starts demo playback", cls.demoplayback === true, `demoplayback=${cls.demoplayback} levelname=${JSON.stringify(cl.levelname)}`);
shot("misc_demo1");
exec("stopdemo", 3);
check("stopdemo ends playback", cls.demoplayback === false, `demoplayback=${cls.demoplayback}`);

// timedemo
exec("clear", 1);
exec("timedemo demo1", 4000);
check("timedemo prints a result line", conHas("seconds") || conHas("fps"), conTail(6));
exec("stopdemo", 3);

// demos / startdemos loop
exec("clear", 1);
exec("demos", 30);
check("`demos` restarts the demo loop", cls.demoplayback === true, `demoplayback=${cls.demoplayback}`);
exec("stopdemo", 3);

summary("S6 misc");
process.exit(0);
