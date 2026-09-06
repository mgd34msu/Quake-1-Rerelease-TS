import { boot, frames, exec } from "./b_lib";
import { Q1TS_DATA } from "./q1data";
boot(["-basedir", Q1TS_DATA, "-game", "e2e_b", "-nosound"]);
frames(10);
exec("map e1m1", 30);
exec("screenshot", 5);
frames(5);
console.log("done");
process.exit(0);
