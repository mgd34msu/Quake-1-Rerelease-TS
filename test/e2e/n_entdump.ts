// N: dump entity-lump blocks matching a filter, for the current map.
import { sv } from "../../src/server/server";
import { boot, waitInGame } from "./n_lib";

const map = process.argv[2] ?? "start";
const filter = process.argv[3] ?? "trigger_multiple";
boot(["+map", map]);
if (waitInGame() < 0) {
  console.log("FATAL: could not load " + map);
  process.exit(1);
}
const wm = sv.worldmodel;
const ents: string = wm ? (wm.entities ?? "") : "";
const blocks = ents.split("}");
let n = 0;
for (const b of blocks) {
  if (!b.includes(filter)) continue;
  n++;
  console.log("--- block " + n + " ---");
  console.log(b.trim().replace(/^\{/, "").trim());
}
console.log(`(${n} blocks matching '${filter}' in ${map}, lump length ${ents.length})`);
process.exit(0);
