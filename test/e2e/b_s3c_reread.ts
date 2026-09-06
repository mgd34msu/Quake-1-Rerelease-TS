import { boot, frames, check, summary, Cvar_VariableValue, keybindings } from "./b_lib";
import { Q1TS_DATA } from "./q1data";
boot(["-basedir",Q1TS_DATA,"-game","e2e_b","-nosound"]);
frames(5);
check("fresh process re-reads config.cfg: sensitivity == 7", Cvar_VariableValue("sensitivity") === 7, `sensitivity=${Cvar_VariableValue("sensitivity")}`);
check("fresh process re-reads config.cfg: viewsize == 90", Cvar_VariableValue("viewsize") === 90, `viewsize=${Cvar_VariableValue("viewsize")}`);
check("fresh process re-reads bindings", keybindings["p".charCodeAt(0)] === "echo b_config_marker", `p=${JSON.stringify(keybindings["p".charCodeAt(0)])}`);
summary("S3c config re-read");
process.exit(0);
