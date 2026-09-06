import { boot, frames, exec } from "./b_lib";
import { Q1TS_DATA } from "./q1data";
boot(["-basedir",Q1TS_DATA,"-game","e2e_b","-nosound"]);
frames(5);
exec("map e1m1", 5);
frames(400, 0.05);   // ~20 s of sim in ONE map load
console.log("DONE");
process.exit(0);
